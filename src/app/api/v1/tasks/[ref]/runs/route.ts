import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { listTaskRuns } from '@/lib/data'

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    return ok(await listTaskRuns(task.id))
  },
})
