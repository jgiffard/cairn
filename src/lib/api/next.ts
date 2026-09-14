import { TASK_PRIORITIES } from '@/schemas/task'

/**
 * Which task to pick up.
 *
 * The briefing lists what is held, what is in flight and what was dropped, and
 * never says which one to do — so every agent invented its own ranking and
 * they did not agree. The query was never the hard part; the ordering is.
 *
 * Two principles decide almost everything here:
 *
 * 1. **Finishing beats starting.** Work already underway is cheaper to
 *    complete than work that has not begun, and work left with a checkpoint is
 *    cheaper still, because somebody already wrote down where they got to.
 * 2. **Never offer what cannot be worked.** Something blocked, or waiting on a
 *    task that is not done, is not a recommendation — it is a trap that costs
 *    an agent a context window to discover.
 */

/** Lower sorts first. */
const TIERS = [
  'holding',
  'checkpointed',
  'in-review',
  'dropped',
  'todo',
  'backlog',
] as const

export type Tier = (typeof TIERS)[number]

export type Candidate = {
  ref: string
  title: string
  status: string
  priority: string
  type?: string | null
  claimedBy?: string | null
  heartbeatAt?: string | null
  updatedAt?: string | null
  checkpoint?: string | null
  blockedAt?: string | null
  /** Tasks this one waits on that are not finished. */
  unmetDeps?: number
}

export type Ranked = Candidate & { tier: Tier; reason: string }

const QUIET_MS = 24 * 60 * 60 * 1000

const priorityRank = (priority: string) => {
  const index = (TASK_PRIORITIES as readonly string[]).indexOf(priority)
  return index === -1 ? TASK_PRIORITIES.length : index
}

/**
 * Someone else is on it, and recently enough to believe.
 *
 * A stale claim is not a reason to skip a task — that is exactly the abandoned
 * work this is meant to surface — so the heartbeat, not the claim, decides.
 */
const heldByAnother = (task: Candidate, me: string | null, now: number) => {
  if (!task.claimedBy || task.claimedBy === me) return false
  const beat = task.heartbeatAt ? Date.parse(task.heartbeatAt) : NaN
  if (Number.isNaN(beat)) return true
  return now - beat < QUIET_MS
}

const tierOf = (task: Candidate, me: string | null, now: number): Tier | null => {
  if (task.status === 'done' || task.status === 'cancelled') return null
  if (task.blockedAt) return null
  if ((task.unmetDeps ?? 0) > 0) return null
  if (heldByAnother(task, me, now)) return null

  if (task.status === 'doing' && task.claimedBy && task.claimedBy === me) return 'holding'
  if (task.status === 'doing') return task.checkpoint ? 'checkpointed' : 'dropped'
  if (task.status === 'in-review') return 'in-review'
  if (task.status === 'todo') return 'todo'
  return 'backlog'
}

const REASONS: Record<Tier, string> = {
  holding: 'you are holding this one — finish it or hand it back',
  checkpointed: 'started, then dropped, and whoever left it wrote down where they got to',
  'in-review': 'the work is done and it is waiting on someone to close it out',
  dropped: 'started and left with nothing written down — check it before trusting it',
  todo: 'queued and ready',
  backlog: 'nothing readier is waiting',
}

/**
 * Ranked, best first. Anything unworkable is absent rather than ordered last:
 * a list that ends in things you must not pick is a list that has to be read
 * to the bottom to be used safely.
 */
export const rankNext = (
  tasks: Candidate[],
  { me = null, now = Date.now() }: { me?: string | null; now?: number } = {},
): Ranked[] =>
  tasks
    .flatMap((task) => {
      const tier = tierOf(task, me, now)
      return tier ? [{ ...task, tier, reason: REASONS[tier] }] : []
    })
    .sort((a, b) => {
      const byTier = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
      if (byTier !== 0) return byTier
      const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
      if (byPriority !== 0) return byPriority
      // Oldest first within a tier, so nothing rots at the bottom for being
      // untouched — the opposite of what "most recently updated" would do.
      return Date.parse(a.updatedAt ?? '') - Date.parse(b.updatedAt ?? '')
    })
