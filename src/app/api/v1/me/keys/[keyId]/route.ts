import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { revokeOwnKey } from '@/lib/api/own-keys'
import { requireOwnKeysHuman } from '@/lib/api/own-keys-route'
import { userAdminFailure } from '@/lib/api/user-admin-route'

/**
 * Revokes one of the caller's own keys, through the same function the
 * administrator route uses. A key that belongs to someone else is a 404 with
 * the same message as one that never existed: this never confirms whose it is.
 */
export const DELETE = route<{ keyId: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireOwnKeysHuman(actor)
    if (denied) return denied
    try {
      return ok(await revokeOwnKey(actor.userId, params.keyId))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
