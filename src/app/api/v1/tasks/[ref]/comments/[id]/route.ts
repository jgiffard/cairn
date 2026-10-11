import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { recordActivity } from '@/lib/api/activity'
import { COMMENT_FIELDS, findTask, refuseArchived } from '@/lib/api/tasks'

export const dynamic = 'force-dynamic'

const editComment = z.object({ content: z.string().min(1).max(100_000) })

/**
 * Edit a comment you wrote.
 *
 * Only its author: the same `actor_type` and `actor_id` the comment was
 * stamped with. A person in the web app is "Cal" and an agent running under the
 * same account is "claude-code · Cal", so neither can rewrite what the other
 * said. Deleting stays out: a conversation that can be unsaid is not a record.
 */
export const PATCH = route<{ ref: string; id: string }, z.infer<typeof editComment>>({
  schema: editComment,
  secretFields: ['content'],
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, 'id, number, project_id')
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    // A malformed id would reach Postgres as an invalid uuid and come back a 500.
    if (!z.string().uuid().safeParse(params.id).success) {
      return fail('not_found', 'No such comment on this task.')
    }

    const { data: found, error: readError } = await admin()
      .from('task_comments')
      .select(COMMENT_FIELDS)
      .eq('id', params.id)
      .eq('task_id', task.id)
      .maybeSingle()
    if (readError) return fail('internal_error', readError.message)
    if (!found) return fail('not_found', 'No such comment on this task.')

    const comment = found as { id: string; content: string; actor_type: string; actor_id: string }
    if (comment.actor_type !== actor.actorType || comment.actor_id !== actor.actorId) {
      return fail(
        'not_author',
        `That comment was written by ${comment.actor_id}. Only its author can edit it.`,
      )
    }

    if (comment.content === body.content) return ok(found)

    const { data, error } = await admin()
      .from('task_comments')
      .update({ content: body.content, edited_at: new Date().toISOString() })
      .eq('id', comment.id)
      .select(COMMENT_FIELDS)
      .maybeSingle()
    if (error) return fail('internal_error', error.message)
    if (!data) return fail('not_found', 'No such comment on this task.')

    await recordActivity(
      [{
        task_id: task.id as string,
        project_id: task.project_id as string,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'comment_edited',
        data: { comment_id: comment.id },
      }],
      actor.userId,
      actor.host,
    )
    return ok(data)
  },
})
