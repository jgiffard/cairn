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
  }>(
    `select id, agent_name, name, key_prefix, created_at, last_used_at, revoked_at
       from api_keys where user_id = $1 order by created_at, id`,
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
