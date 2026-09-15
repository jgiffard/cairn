import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

/**
 * Drops a claim without closing the task. This is the whole of "handoff" —
 * release, having left a checkpoint. No contract, no invitation, no accept.
 */
const releaseBody = z.object({ ownershipVersion: z.number().int().nonnegative().optional() })

export const POST = route<{ ref: string }, z.infer<typeof releaseBody>>({
  schema: releaseBody,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const version = body.ownershipVersion ?? Number(task.ownership_version ?? 0)
    const expectedHolder = actor.actorType === 'agent' ? actor.actorId : null
    const { data, error } = await admin().rpc<Record<string, unknown> | null>('release_task_atomic', {
      p_task_id: task.id,
      p_owner_user_id: actor.userId,
      p_actor_type: actor.actorType,
      p_actor_id: actor.actorId,
      p_expected_version: version,
      p_expected_holder: expectedHolder,
    })

    if (error) return fail('internal_error', error.message)
    if (!data) return fail('conflict', 'Claim ownership changed; nothing was released.')

    return ok(data)
  },
})
