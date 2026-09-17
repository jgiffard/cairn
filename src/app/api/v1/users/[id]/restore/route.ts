import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { restoreUser } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

export const POST = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await restoreUser(params.id))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
