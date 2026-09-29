import type { Actor } from './auth'
import { requireHumanActor } from './connect-route'

/**
 * Only a person, in a browser, manages their own keys. An agent key — even a
 * perfectly valid one — must not be able to list its siblings or revoke the
 * keys of the other agents on the same account.
 */
export const requireOwnKeysHuman = (actor: Actor): Response | null =>
  requireHumanActor(actor, 'Only a signed-in person, in a browser, can list or revoke their agent keys.')
