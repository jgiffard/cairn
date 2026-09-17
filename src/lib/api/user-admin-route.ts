import type { Actor } from './auth'
import { canAdministerUsers } from './actor'
import { UserAdminError } from './users'
import { fail } from './response'

export const requireUserAdministrator = (actor: Actor): Response | null =>
  canAdministerUsers(actor)
    ? null
    : fail('forbidden', 'Only a signed-in administrator can manage users and credentials.')

export const userAdminFailure = (error: unknown): Response => {
  if (error instanceof UserAdminError) {
    if (error.code === 'not_found') return fail('not_found', error.message)
    return fail('conflict', error.message)
  }
  throw error
}
