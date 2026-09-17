import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'
import { revokeUserKey } from '@/lib/api/users'

export const dynamic = 'force-dynamic'

/** Revokes rather than deletes, so `last_used_at` history survives an incident. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await revokeUserKey(actor.userId, params.id))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
