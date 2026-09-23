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
 * Current entries nobody was given in `days`, never-recalled first. An entry younger
 * than the window is left out: it has not had the chance.
 */
export const unusedKnowledge = async (days: number, limit: number): Promise<UnusedEntry[]> => {
  // Rank the eligible set by all-time history *before* applying the output
  // limit. Otherwise an older, once-recalled fact can crowd out a newer fact
  // that has never been recalled. Restrict the all-time count to entries that
  // are already unused in the requested window.
  const { rows } = await pool().query(
    `with eligible as materialized (
       select k.id, k.slug, k.title, k.created_at
         from knowledge_recall_counts($1) w
         join knowledge k on k.id = w.knowledge_id
        where w.returned = 0 and w.read = 0
          and k.superseded_by is null
          and k.created_at < $1
     ), ever as (
       select * from knowledge_recall_counts('-infinity'::timestamptz,
         coalesce((select array_agg(id) from eligible), '{}'::uuid[]))
     )
     select e.slug, e.title, e.created_at, h.last_recalled
       from eligible e
       join ever h on h.knowledge_id = e.id
      order by h.last_recalled asc nulls first, e.created_at asc, e.id asc
      limit $2`,
    [since(days), limit],
  )
  return rows.map((r) => ({
    slug: r.slug as string,
    title: r.title as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    lastRecalled: r.last_recalled ? new Date(r.last_recalled as string).toISOString() : null,
  }))
}
