import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { revokeUserKey } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

export const DELETE = route<{ id: string; keyId: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await revokeUserKey(params.id, params.keyId))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
