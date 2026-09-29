import { pool } from '@/lib/db/client'
import { revokeUserKey } from './users'

/**
 * One of the signed-in person's own agent keys, as they are allowed to see it
 * (CAIRN-315). Never the hash, never the secret: the plaintext was shown once,
 * at pairing, and nothing here could reproduce it.
 */
export type OwnKey = {
  id: string
  agentName: string
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  /**
   * Whether the key is actually usable — `revokedAt` alone is not enough.
   *
   * `authenticate()` also refuses a key whose `auth_epoch` has fallen behind
   * its user's (a bump kills every key issued before it in one write, without
   * touching each row's `revoked_at`). Today the one place that bumps a
   * user's epoch — deactivating them — revokes every key in the same
   * transaction, so the two never disagree in practice. This checks the
   * epoch anyway rather than trusting that invariant to hold forever: a key
   * the server would refuse must never read back as active here.
   */
  revoked: boolean
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString()

export const listOwnKeys = async (userId: string): Promise<OwnKey[]> => {
  const result = await pool().query<{
    id: string
    agent_name: string
    name: string
    key_prefix: string
    created_at: Date
    last_used_at: Date | null
    revoked_at: Date | null
    key_auth_epoch: string
    user_auth_epoch: string
  }>(
    `select k.id, k.agent_name, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
            k.auth_epoch as key_auth_epoch, u.auth_epoch as user_auth_epoch
       from api_keys k
       join app_users u on u.id = k.user_id
      where k.user_id = $1
      order by k.created_at, k.id`,
    [userId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    agentName: row.agent_name,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: iso(row.created_at)!,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    revoked: row.revoked_at !== null || row.key_auth_epoch !== row.user_auth_epoch,
  }))
}

/**
 * The administrator's revocation, with the caller as the owner — so a key
 * that is someone else's is `not_found`, exactly like one that never existed.
 */
export const revokeOwnKey = async (
  userId: string,
  keyId: string,
): Promise<{ id: string; agentName: string; revokedAt: string }> => {
  const key = await revokeUserKey(userId, keyId)
  return { id: key.id, agentName: key.agent_name, revokedAt: iso(key.revoked_at)! }
}
