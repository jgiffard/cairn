import type { Actor } from './auth'
import { ConnectError } from './connect'
import { fail } from './response'

/**
 * Approving or denying a pairing request mints keys for a real person, so it
 * has to be that person at a keyboard — an agent key is never the right
 * caller here, even one belonging to an administrator.
 */
export const requireHumanActor = (actor: Actor): Response | null =>
  actor.actorType === 'human'
    ? null
    : fail('forbidden', 'Only a signed-in person, in a browser, can approve or deny a pairing request.')

export const connectFailure = (error: unknown): Response => {
  if (error instanceof ConnectError) {
    if (error.code === 'not_found') return fail('not_found', error.message)
    if (error.code === 'invalid_runtimes') return fail('validation_failed', error.message)
    if (error.code === 'forbidden_runtime') return fail('forbidden', error.message)
    return fail('conflict', error.message)
  }
  throw error
}
