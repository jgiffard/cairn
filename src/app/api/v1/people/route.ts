import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { listPeople } from '@/lib/api/people'

export const dynamic = 'force-dynamic'

/**
 * Who work can be assigned to. Open to every caller, agents included, because
 * the workspace is shared and naming an assignee is ordinary work; `/users`
 * stays the admin surface for roles, keys and lifecycle.
 */
export const GET = route({
  handler: async () => ok(await listPeople()),
})
