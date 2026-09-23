import { pool } from '@/lib/db/client'

/**
 * How often each fact is recalled (CAIRN-270), from what 053 already records:
 * searches that returned it and direct reads that fetched it. Not counted: the
 * session briefing and `cairn recall`, which record nothing — every surface
 * showing these numbers has to say so, or an entry the briefing shows daily
 * reads as dead.
 */

export const RECALL_WINDOW_DAYS = 30

export const COUNTED =
  'counts check/know searches that returned it and direct reads; the session briefing and cairn recall are not recorded'

export type RecallCount = {
  returned: number
  read: number
  lastRecalled: string | null
}

const since = (days: number) =>
  Number.isFinite(days) ? new Date(Date.now() - days * 86_400_000).toISOString() : '-infinity'

export const recallCounts = async (
  ids: string[],
  days = RECALL_WINDOW_DAYS,
): Promise<Map<string, RecallCount>> => {
  const out = new Map<string, RecallCount>()
  if (ids.length === 0) return out
  const { rows } = await pool().query(
    'select knowledge_id, returned, read, last_recalled from knowledge_recall_counts($1, $2::uuid[])',
    [since(days), ids],
  )
  for (const r of rows) {
    out.set(r.knowledge_id as string, {
      returned: r.returned as number,
      read: r.read as number,
      lastRecalled: r.last_recalled ? new Date(r.last_recalled as string).toISOString() : null,
    })
  }
  return out
}

export type UnusedEntry = {
  slug: string
  title: string
  createdAt: string
  /** Ever, not just in the window. Null means no record of it being recalled at all. */
  lastRecalled: string | null
}

/**
 * Current entries nobody was given in `days`, oldest first. An entry younger
 * than the window is left out: it has not had the chance.
 */
export const unusedKnowledge = async (days: number, limit: number): Promise<UnusedEntry[]> => {
  // The window first, which the created_at indexes bound. "Last recalled ever"
  // has no bound, so cap the candidate IDs before asking about history. The
  // oldest-created unused entries are the bounded candidate set; the requested
  // limit must constrain both this query and the all-time lookup below.
  const { rows: candidates } = await pool().query(
    `select k.id, k.slug, k.title, k.created_at
       from knowledge_recall_counts($1) w
       join knowledge k on k.id = w.knowledge_id
      where w.returned = 0 and w.read = 0
        and k.superseded_by is null
        and k.created_at < $1
      order by k.created_at asc, k.id asc
      limit $2`,
    [since(days), limit],
  )
  if (candidates.length === 0) return []

  const ever = await recallCounts(
    candidates.map((c) => c.id as string),
    Number.POSITIVE_INFINITY,
  )
  return candidates
    .map((c) => ({
      slug: c.slug as string,
      title: c.title as string,
      createdAt: new Date(c.created_at as string).toISOString(),
      lastRecalled: ever.get(c.id as string)?.lastRecalled ?? null,
    }))
    .sort(
      (a, b) =>
        (a.lastRecalled ?? '').localeCompare(b.lastRecalled ?? '') || a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, limit)
}
