import { admin } from '@/lib/db/client'
import { projectIdForFormerKey } from './project-keys'

/**
 * Query construction for prior-work discovery.
 *
 * Postgres full-text search ANDs the terms of a websearch query, which is the
 * right default for precision: an agent searching "supavisor pool timeouts"
 * wants the task about exactly that. It is the wrong behaviour when the agent
 * words the subject differently from whoever filed it, which is most of the
 * time — and a zero-result search reads as "this is new", the single most
 * expensive wrong answer this system can give.
 *
 * So: try the precise query first, and widen only when it comes back thin.
 * Precision is preserved where it works, recall is recovered where it does not.
 */

/** Words too common to be worth ORing on; they would match half the corpus. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'why', 'how', 'are', 'was', 'were', 'not', '但', 'les', 'des', 'une', 'dans',
  'pour', 'avec', 'sur', 'est', 'sont', 'pas', 'que', 'qui',
])

export const distinctiveTerms = (query: string): string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    ),
  ].slice(0, 8)

/**
 * The distinctive terms, passed to the database as an array.
 *
 * The database needs the terms individually, not pre-joined: it ranks widened
 * results by how many DISTINCT terms a row matches, which cannot be recovered
 * from an already-ORed string.
 */
export const widenedTerms = (query: string): string[] | null => {
  const terms = distinctiveTerms(query)
  return terms.length >= 2 ? terms : null
}

export type SearchRow = {
  id: string
  number: number
  title: string
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  description: string | null
  claimed_by: string | null
  updated_at: string
  external_ref: string | null
  project_key: string
  rank: number
  coverage: number
  widened: boolean
}

/**
 * Ranking happens in Postgres, via the search_tasks function.
 *
 * ts_rank needs the tsvector and tsquery together, and PostgREST cannot order
 * by an expression it did not select — so ordering here would mean ordering by
 * something other than relevance. Doing exactly that (recency) dropped
 * measured recall from 75% to 6%: widening returns many more rows, and a
 * recency sort buries the exact match among them.
 */
/**
 * A ref is an exact address, not a phrase to match.
 *
 * Searching `CAIRN-131` returned CAIRN-105 — the task whose resolution
 * mentions it — and never 131 itself; searching `CAIRN-106` returned nothing at
 * all. The ref is a project key plus a number, and the key lives in another
 * table, so no generated column on `tasks` can reach it and the vector has
 * never contained it.
 *
 * That matters more here than it looks. A ref is designed to escape into
 * commits, notes and transcripts precisely so it can be pasted back, and
 * `cairn check` is the verb every agent is told to run first. Pasting one in
 * got you everything that mentions it and never the thing you asked for.
 *
 * So a ref-shaped query is resolved directly and put first, and the full-text
 * pass still runs underneath it — what references this task is a genuinely
 * useful second answer, just not the only one.
 */
const REF_QUERY = /^\s*([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\s*$/

type ExactTask = {
  id: string
  number: number
  title: string
  description: string | null
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  external_ref: string | null
  updated_at: string
  project: { key: string } | { key: string }[] | null
}

const keyOfProject = (project: ExactTask['project']) =>
  (Array.isArray(project) ? project[0]?.key : project?.key) ?? null

/**
 * The task a ref names, including through a key the project used to have —
 * the whole point of retaining former keys is that old refs keep resolving.
 */
const taskByRef = async (userId: string, q: string): Promise<ExactTask | null> => {
  const match = REF_QUERY.exec(q)
  if (!match?.[1] || !match[2]) return null
  const key = match[1].toUpperCase()
  const number = Number(match[2])

  // The same columns the ranked rows carry. A row assembled here renders in the
  // same list, so a stubbed priority or a missing claim would read as fact.
  const columns =
    'id, number, title, description, type, status, priority, resolution, ' +
    'resolution_kind, claimed_by, external_ref, updated_at, ' +
    'project:projects!project_id!inner(key, owner_user_id)'

  const { data } = await admin()
    .from('tasks')
    .select(columns)
    .eq('projects.owner_user_id', userId)
    .eq('projects.key', key)
    .eq('number', number)
    .maybeSingle()

  if (data) return data as unknown as ExactTask

  const projectId = await projectIdForFormerKey(userId, key)
  if (!projectId) return null

  const { data: byFormer } = await admin()
    .from('tasks')
    .select(columns)
    .eq('projects.owner_user_id', userId)
    .eq('project_id', projectId)
    .eq('number', number)
    .maybeSingle()

  return (byFormer as unknown as ExactTask) ?? null
}

const asSearchAllRow = (task: ExactTask): SearchAllRow => ({
  kind: 'task',
  id: task.id,
  ref: `${keyOfProject(task.project)}-${task.number}`,
  title: task.title,
  subtitle: task.description?.slice(0, 200) ?? null,
  project_key: keyOfProject(task.project),
  status: task.status,
  type: task.type,
  answered: Boolean(task.resolution),
  updated_at: task.updated_at,
  body_bytes: (task.description?.length ?? 0) + (task.resolution?.length ?? 0),
  // Above every ranked hit on purpose: an exact address outranks a mention.
  rank: Number.POSITIVE_INFINITY,
  widened: false,
})

export const searchTasks = async (
  userId: string,
  q: string,
  filters: { project?: string; type?: string; status?: string },
  limit: number,
): Promise<{ rows: SearchRow[]; widened: boolean }> => {
  const { data, error } = await admin().rpc('search_tasks', {
    p_owner: userId,
    p_query: q,
    p_terms: widenedTerms(q),
    p_project: filters.project ?? null,
    p_type: filters.type ?? null,
    p_status: filters.status ?? null,
    p_limit: limit,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchRow[]

  // Same rule on the task-only path, which is what the UI uses the moment a
  // type or status filter is set — and what `cairn check --tasks` uses.
  const exact = await taskByRef(userId, q)
  if (!exact) return { rows, widened: rows.some((r) => r.widened) }

  const key = keyOfProject(exact.project)
  // A filter the caller set is a statement about what they want back; an exact
  // ref does not override it.
  const excluded =
    (filters.project && filters.project.toUpperCase() !== key) ||
    (filters.type && filters.type !== exact.type) ||
    (filters.status && filters.status !== exact.status)
  if (excluded) return { rows, widened: rows.some((r) => r.widened) }

  const head: SearchRow = {
    id: exact.id,
    number: exact.number,
    title: exact.title,
    type: exact.type,
    status: exact.status,
    priority: exact.priority,
    resolution: exact.resolution,
    resolution_kind: exact.resolution_kind,
    description: exact.description,
    claimed_by: exact.claimed_by,
    updated_at: exact.updated_at,
    external_ref: exact.external_ref,
    project_key: key ?? '',
    rank: Number.POSITIVE_INFINITY,
    coverage: 1,
    widened: false,
  }
  const deduped = [head, ...rows.filter((r) => r.id !== exact.id)]
  return { rows: deduped.slice(0, limit), widened: rows.some((r) => r.widened) }
}

/**
 * The unified index: tasks, work-log notes, knowledge and sessions.
 *
 * `search_tasks` above is kept because the UI and the duplicate probe both
 * want tasks and only tasks. This is what `cairn check` calls, because the
 * agent asking "has this been done or debugged" does not care which table the
 * answer happens to live in — and for two years the answer most likely to
 * exist, a work-log note, was the one table nothing searched.
 */
export type SearchAllRow = {
  kind: 'task' | 'note' | 'knowledge' | 'session'
  id: string
  ref: string
  title: string
  subtitle: string | null
  project_key: string | null
  status: string | null
  type: string | null
  answered: boolean
  updated_at: string
  body_bytes: number
  rank: number
  widened: boolean
}

export const searchAll = async (
  userId: string,
  q: string,
  filters: { project?: string; kinds?: string[] },
  limit: number,
): Promise<{ rows: SearchAllRow[]; widened: boolean }> => {
  const { data, error } = await admin().rpc('search_all', {
    p_owner: userId,
    p_query: q,
    p_terms: widenedTerms(q),
    p_project: filters.project ?? null,
    p_kinds: filters.kinds && filters.kinds.length > 0 ? filters.kinds : null,
    p_limit: limit,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchAllRow[]

  // The task a ref names, first, and never twice: the full-text pass can also
  // find it legitimately, by title.
  const exact = filters.kinds && !filters.kinds.includes('task') ? null : await taskByRef(userId, q)
  const withExact = exact
    ? [asSearchAllRow(exact), ...rows.filter((r) => !(r.kind === 'task' && r.id === exact.id))]
    : rows

  // Widened describes the full-text pass. An exact hit is not a loose match and
  // must not make the caller think the rest were precise.
  return { rows: withExact.slice(0, limit), widened: rows.some((r) => r.widened) }
}
