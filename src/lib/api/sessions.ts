import { admin } from '@/lib/db/client'
import { resolveProject } from './project-keys'
import type { Actor } from './auth'
import { actorLabel } from './actor'
import type { SessionUpsert } from '@/schemas/session'
import { recordFiles } from './files'

/**
 * Sessions: the episodic record, written at the end of one.
 *
 * This is the half of memory an agent cannot be trusted to write on purpose,
 * so nothing here depends on it choosing to. A session-end hook posts what the
 * transcript already contains; the only judgement involved is four prose
 * fields, and a session with none of them is still worth the row.
 *
 * Idempotent on (platform_source, external_id) because that is a correctness
 * requirement, not a nicety: Codex has no session-end event so its writer runs
 * on Stop, which fires once per turn, and OpenClaw's runs from a reconciler
 * that may sweep a session the hook already recorded.
 */

const COLUMNS =
  'id, external_id, platform_source, agent_id, cwd, project_id, started_at, ended_at, ' +
  'request, learned, completed, next_steps, files, task_refs, tool_calls, scheduled, created_at, updated_at'

export type SessionRow = {
  id: string
  external_id: string
  platform_source: string
  agent_id: string | null
  cwd: string | null
  project_id: string | null
  started_at: string | null
  ended_at: string | null
  request: string | null
  learned: string | null
  completed: string | null
  next_steps: string | null
  files: string[]
  task_refs: string[]
  tool_calls: number | null
  scheduled: boolean
  created_at: string
  updated_at: string
}

/**
 * Live or retired: a session recorded from a checkout still mapped to AC
 * belongs to the project AC became, not to no project at all (CAIRN-264).
 */
const projectIdForKey = async (_userId: string, key?: string): Promise<string | null> => {
  if (!key) return null
  return (await resolveProject(key))?.project.id ?? null
}

/**
 * Checkpoints every task this agent still holds, using the session summary.
 *
 * This is the discipline mechanism, and the reason it lives on the server
 * rather than in the hook: whatever the agent did or did not bother to record,
 * a claim it walked away from stops being a phantom hold on the board. It
 * never *closes* anything — closing needs a resolution somebody meant.
 */
const RECORDED = '_Recorded automatically when the session ended._'

/**
 * Which held tasks this session actually worked, and which it merely held.
 *
 * Pure, and exported, because the distinction is the whole point of the fix and
 * the failure it prevents is silent: a wrong checkpoint reads exactly like a
 * right one.
 */
/**
 * The subset a given session may write a checkpoint onto.
 *
 * Pure and exported beside splitHeldByWorked, because this is the other half
 * of the same silent failure: a wrong checkpoint reads exactly like a right
 * one, and `cairn context` hands it to the next agent as fact.
 *
 * A task whose claim names no session is kept. It was claimed before the
 * column existed, or by a runtime that cannot name itself, and dropping those
 * would quietly stop checkpointing work that is genuinely held — trading a
 * silent bug for a silent regression.
 */
export const heldByThisSession = <T extends { claimed_session: string | null }>(
  held: T[],
  sessionId: string | null,
): T[] =>
  sessionId ? held.filter((t) => t.claimed_session === null || t.claimed_session === sessionId) : held

export const splitHeldByWorked = <T>(
  held: T[],
  taskRefs: string[],
  refOf: (task: T) => string,
): { touched: T[]; untouched: T[] } => {
  const worked = new Set(taskRefs)
  return {
    touched: held.filter((t) => worked.has(refOf(t))),
    untouched: held.filter((t) => !worked.has(refOf(t))),
  }
}

/** What a task the session actually advanced gets told. */
export const workedCheckpoint = (summary: string) => `${summary}\n\n${RECORDED}`

/**
 * What a task that was only held gets told: the true thing, plus where the
 * session's attention actually went, so the reader can judge whether the claim
 * is still meant. It deliberately does not repeat the summary — that summary is
 * about other work, and repeating it here is the bug this replaces.
 */
export const untouchedCheckpoint = (taskRefs: string[]) => {
  const elsewhere = taskRefs.slice(0, 5).join(', ')
  return (
    'Still held, not progressed: the session that held this claim worked' +
    (elsewhere ? ` on ${elsewhere}` : ' elsewhere') +
    `.\n\n${RECORDED}`
  )
}

const checkpointHeldTasks = async (actor: Actor, session: SessionRow): Promise<string[]> => {
  if (!actor.actorId) return []

  const { data, error } = await admin()
    .from('tasks')
    .select('id, number, claimed_session, project:projects!project_id!inner(key)')
    .eq('claimed_by', actor.actorId)
  if (error) throw new Error(error.message)

  const all = (data ?? []) as unknown as {
    id: string
    number: number
    claimed_session: string | null
    project: { key: string }
  }[]

  /**
   * Held by THIS session, not by everything wearing the same name.
   *
   * `claimed_by` is an actorLabel, so four Claude Code sessions on one machine
   * all match it. This used to write one session's checkpoint onto another
   * session's tasks: three knowledge-map tasks carried a report about merging
   * an unrelated pull request, because the identity matched and nothing else
   * was consulted. CAIRN-182 fixed the version of this that stamped tasks the
   * session never touched; the same wrong summary arrives here through
   * identity instead of through the file list.
   *
   * A task with no claimed_session is still included. It was claimed before
   * that column existed, or by a runtime with no session to give, and
   * excluding it would quietly stop checkpointing work that is genuinely held
   * — a silent regression to fix a silent bug.
   */
  const held = heldByThisSession(all, actor.sessionId)
  if (held.length === 0) return []

  const summary = [session.completed, session.next_steps && `Next: ${session.next_steps}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4_000)

  if (!summary) return []

  const at = session.ended_at ?? new Date().toISOString()

  /**
   * A held task is not necessarily a worked task.
   *
   * This used to write the same summary to everything the agent held, so a
   * task claimed days ago and never opened received a progress report about
   * different work entirely — BB-359, a task about login failures, was stamped
   * with a summary of a UI refactor. Checkpoints are read back by `cairn
   * context` and the session banner, so a wrong one is not inert: it is handed
   * to the next agent as fact.
   *
   * `task_refs` already records what the session actually touched, so the two
   * cases can be told apart without any new data.
   */
  const refOf = (t: { number: number; project: { key: string } }) =>
    `${t.project.key}-${t.number}`

  const { touched, untouched } = splitHeldByWorked(held, session.task_refs ?? [], refOf)

  const write = async (rows: typeof held, text: string) => {
    if (rows.length === 0) return
    const { error: updateError } = await admin()
      .from('tasks')
      .update({ checkpoint_summary: text, checkpoint_at: at })
      .in(
        'id',
        rows.map((t) => t.id),
      )
    if (updateError) throw new Error(updateError.message)
  }

  await write(touched, workedCheckpoint(summary))
  await write(untouched, untouchedCheckpoint(session.task_refs ?? []))

  return held.map(refOf)
}

/**
 * Keeps only refs whose project actually exists in the workspace.
 *
 * A transcript is scraped with a regex, and `[A-Z][A-Z0-9]+-\d+` matches
 * `SHA-256`, `HTTP-01`, `UTF-8` and the `Z0-9` out of a character class as
 * happily as it matches `CAIRN-64`. Filtering at the source would need a
 * blocklist that is wrong the moment someone names a project ISO; the
 * workspace project keys are the only authority that stays right.
 */
const keepRealRefs = async (_userId: string, refs: string[]): Promise<string[]> => {
  if (refs.length === 0) return []

  const { data, error } = await admin()
    .from('projects')
    .select('key')
  if (error) throw new Error(error.message)

  const keys = new Set((data ?? []).map((p) => (p.key as string).toUpperCase()))
  const kept = refs.filter((ref) => keys.has(ref.split('-')[0]?.toUpperCase() ?? ''))
  return [...new Set(kept)].slice(0, 100)
}

export const upsertSession = async (actor: Actor, input: SessionUpsert) => {
  const projectId = await projectIdForKey(actor.userId, input.project)
  const taskRefs = await keepRealRefs(actor.userId, input.taskRefs)

  const row = {
    owner_user_id: actor.userId,
    external_id: input.externalId,
    platform_source: input.platformSource,
    // Hooks may report the runtime name, but the authenticated key owns the
    // identity. Qualify caller-supplied names just like every other durable
    // attribution so two users running `codex` stay distinguishable.
    agent_id: input.agentId
      ? actorLabel('agent', input.agentId, actor.userDisplayName)
      : actor.actorId,
    cwd: input.cwd ?? null,
    project_id: projectId,
    started_at: input.startedAt ?? null,
    ended_at: input.endedAt ?? new Date().toISOString(),
    request: input.request ?? null,
    learned: input.learned ?? null,
    completed: input.completed ?? null,
    next_steps: input.nextSteps ?? null,
    files: input.files,
    task_refs: taskRefs,
    tool_calls: input.toolCalls ?? null,
    scheduled: input.scheduled ?? false,
  }

  const { data, error } = await admin()
    .from('sessions')
    .upsert(row, { onConflict: 'platform_source,external_id' })
    .select(COLUMNS)
    .single<SessionRow>()

  if (error) throw new Error(error.message)

  await recordFiles(actor.userId, {
    paths: input.files,
    sessionId: data.id,
    projectId,
  })

  const checkpointed = input.checkpointHeld ? await checkpointHeldTasks(actor, data) : []

  return { session: data, checkpointed }
}

export const listSessions = async (
  _userId: string,
  filters: {
    project?: string
    cwd?: string
    agent?: string
    limit: number
    /** Keyset cursor for the timeline: rows strictly older than this. */
    before?: string
  },
): Promise<SessionRow[]> => {
  let query = admin()
    .from('sessions')
    .select(COLUMNS)
    .order('ended_at', { ascending: false, nullsFirst: false })
    .limit(filters.limit)

  if (filters.cwd) query = query.eq('cwd', filters.cwd)
  if (filters.agent) query = query.eq('agent_id', filters.agent)
  // Strictly before, not <=: the cursor is the last row already shown, and
  // <= would repeat it (or, worse, drop every other row sharing its instant).
  if (filters.before) query = query.lt('ended_at', filters.before)
  if (filters.project) {
    const projectId = await projectIdForKey(_userId, filters.project)
    if (!projectId) return []
    query = query.eq('project_id', projectId)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SessionRow[]
}

/** Distinct agent ids seen, for the sessions timeline's filter. */
export const listSessionAgents = async (_userId: string): Promise<string[]> => {
  const { data, error } = await admin()
    .from('sessions')
    .select('agent_id')
    .not('agent_id', 'is', null)
  if (error) throw new Error(error.message)

  return [...new Set((data ?? []).map((r) => r.agent_id as string))].sort()
}

/** Project keys for the ids on a page of sessions, so the timeline can show one. */
export const projectKeysById = async (
  _userId: string,
  ids: string[],
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return out

  const { data, error } = await admin()
    .from('projects')
    .select('id, key')
    .in('id', wanted)
  if (error) throw new Error(error.message)

  for (const row of data ?? []) out.set(row.id as string, row.key as string)
  return out
}
