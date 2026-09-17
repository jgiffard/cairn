import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { createActivityEvidenceSchema } from '@/schemas/task'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

/**
 * The audit trail. `task_activity_events` has been written since the first
 * migration and, until now, read by nothing at all — the data accumulated
 * invisibly for the entire life of the system.
 *
 * Distinct from `/notes`, which is what an agent chose to say. This is what
 * actually happened, whether anyone narrated it or not.
 */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)

    const { data, error } = await admin()
      .from('task_activity_events')
      .select('id, event, data, actor_type, actor_id, created_at')
      .eq('task_id', task.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) return fail('internal_error', error.message)
    return ok(data ?? [])
  },
})

export const POST = route<{ ref: string }, z.infer<typeof createActivityEvidenceSchema>>({
  schema: createActivityEvidenceSchema,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { event, ...data } = body
    const { data: row, error } = await admin()
      .from('task_activity_events')
      .insert({
        owner_user_id: actor.userId,
        task_id: task.id,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event,
        data,
      })
      .select('id, event, data, actor_type, actor_id, created_at')
      .single()

    /**
     * A commit recorded twice is the same commit.
     *
     * This is written by hooks and CI steps — callers that time out and retry —
     * so a second attempt must not add a second line to the timeline claiming
     * the work happened twice. A note has been idempotent on its content hash
     * for the same reason; evidence had no such protection. The index that
     * makes this reachable is partial: a run_result has no sha, and running the
     * tests again after a fix is a different fact, not a duplicate.
     */
    if (error?.code === '23505') {
      const { data: existing } = await admin()
        .from('task_activity_events')
        .select('id, event, data, actor_type, actor_id, created_at')
        .eq('task_id', task.id)
        .eq('event', event)
        .limit(50)
      const match = ((existing ?? []) as { data: { sha?: string } }[]).find(
        (row) => row.data?.sha === data.sha,
      )
      return ok(match ?? { duplicate: true }, { status: 200 })
    }

    if (error) return failFromDb(error)
    return ok(row, { status: 201 })
  },
})
