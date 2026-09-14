import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { CLAIM_LEASE_SECONDS } from '@/lib/utils'

/**
 * Taking a task, as one conditional UPDATE.
 *
 * Extracted so the claim route and the implicit claim below cannot drift into
 * two different ideas of what holding a task means — the lease window, the
 * attempt counter and the recorded events are the coordination layer, and a
 * second copy of them would be a second answer to "who has this".
 */
export const takeTask = async (
  actor: Actor,
  task: { id: string; status?: unknown; attempt?: unknown; project_id?: unknown },
  { agent, setDoing = true }: { agent?: string; setDoing?: boolean } = {},
) => {
  const holder = agent ?? actor.actorId
  const now = new Date()
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_SECONDS * 1000).toISOString()

  const patch: Record<string, unknown> = {
    claimed_by: holder,
    claimed_at: now.toISOString(),
    heartbeat_at: now.toISOString(),
    attempt: ((task.attempt as number) ?? 0) + 1,
  }
  if (setDoing) patch.status = 'doing'

  const { data, error } = await admin()
    .from('tasks')
    .update(patch)
    .eq('id', task.id)
    .or(`claimed_by.is.null,heartbeat_at.lt.${staleBefore}`)
    .select('id, number, status, claimed_by, claimed_at, heartbeat_at, attempt')

  if (error) return { row: null, error: error.message }
  if (!data || data.length === 0) return { row: null, error: null } // somebody else holds it

  const events: Record<string, unknown>[] = [
    {
      task_id: task.id,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event: 'claimed',
      data: { agent: holder, attempt: patch.attempt },
    },
  ]

  // Claiming moves the task to `doing`, and that move is recorded like any
  // other — without it, history showed tasks going straight from backlog to
  // done and "do agents start their work" answered the opposite of the truth.
  if (patch.status && patch.status !== task.status) {
    events.push({
      task_id: task.id,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      event: 'status_changed',
      data: { from: task.status, to: patch.status, via: 'claim' },
    })
  }

  await admin()
    .from('task_activity_events')
    .insert(events.map((e) => ({ owner_user_id: actor.userId, project_id: task.project_id ?? null, ...e })))
  return { row: (data as Record<string, unknown>[])[0], error: null }
}

/**
 * A checkpoint claims the task. A note does not.
 *
 * The first version claimed on any work-log write, to fix a real problem: 36%
 * of closed tasks were never claimed, so they never showed as In Progress
 * while somebody was on them, and no amount of restating the rule had changed
 * that.
 *
 * It was too broad, and an agent reported it against real history. Triaging a
 * backlog, it wrote a `finding` on a task it was only READING; the task went
 * to `doing`; that read as false, so the agent reverted it; minutes later it
 * began actually working and never re-claimed. The task was never `doing`
 * during the only window when it was genuinely being worked — the exact
 * failure the auto-claim existed to prevent, caused by the auto-claim.
 *
 * A note is an annotation, and annotating is most of what reading a backlog
 * is. A checkpoint is not: it says "here is where I got to", which nobody
 * writes about work they are not doing. So the inference moved to the one
 * signal that carries it unambiguously, and `cairn note` says plainly when a
 * task is unclaimed instead of quietly deciding for you.
 *
 * Three limits, unchanged:
 *   - agents only. Humans coordinate by talking, and a person leaving a
 *     comment does not mean they have picked the work up.
 *   - never steals. If somebody else holds a live lease this does nothing.
 *   - never reopens. A note on a closed task is a postscript, not a restart.
 */
export const shouldClaimByWorking = (
  actor: { actorType: string },
  task: Record<string, unknown>,
): boolean => {
  if (actor.actorType !== 'agent') return false
  if (task.claimed_by) return false
  const status = task.status as string
  return status !== 'done' && status !== 'cancelled'
}

export const claimByWorking = async (
  actor: Actor,
  task: { id: string; status?: unknown; attempt?: unknown; claimed_by?: unknown },
) => {
  if (!shouldClaimByWorking(actor, task)) return null
  const { row } = await takeTask(actor, task)
  return row
}
