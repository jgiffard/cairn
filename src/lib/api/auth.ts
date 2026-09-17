import { pool } from '@/lib/db/client'
import { sessionUser } from '@/lib/auth/session'
import { actorLabel, type UserRole } from './actor'
import { hashApiKey, hashesMatch, looksLikeApiKey } from './keys'

/**
 * Who is making a request.
 *
 * `userId` identifies the human behind the request. Workspace data is shared;
 * `actorType`/`actorId` are what get stamped on writes, so the shared memory records which of
 * Claude Code, Codex or OpenClaw did a thing — that attribution is most of
 * what makes the work log worth reading.
 */
export type Actor = {
  userId: string
  actorType: 'human' | 'agent'
  actorId: string
  userDisplayName: string
  role: UserRole
  /** Identity used for rate limiting: the key id, or the user for UI sessions. */
  rateKey: string
}

const bearerToken = (req: Request): string | null => {
  const header = req.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

/**
 * Agents authenticate with a bearer API key; the human UI authenticates with
 * its application session cookie. Deliberately not HMAC request signing: TLS,
 * opaque revocable credentials and server-side authorization provide the
 * boundary without making every caller implement canonicalisation and nonces.
 */
export const authenticate = async (req: Request): Promise<Actor | null> => {
  const token = bearerToken(req)

  if (token && looksLikeApiKey(token)) {
    const tokenHash = hashApiKey(token)
    const { rows } = await pool().query<{
      id: string
      user_id: string
      agent_name: string
      key_hash: string
      role: UserRole
      user_display_name: string
    }>(
      `select k.id, k.user_id, k.agent_name, k.key_hash, u.role,
              coalesce(nullif(trim(p.display_name), ''), u.email) as user_display_name
         from api_keys k
         join app_users u on u.id = k.user_id
         left join user_profiles p on p.id = u.id
        where k.key_hash = $1 and k.revoked_at is null
          and k.auth_epoch = u.auth_epoch
          and u.deleted_at is null
          and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
        limit 1`,
      [tokenHash],
    )
    const data = rows[0]
    if (!data || !hashesMatch(data.key_hash, tokenHash)) return null

    // Best-effort; a failed touch must never fail the request.
    //
    // NOTE: this must be `.then(...)`, not `void <builder>`. The query
    // builder is a lazy thenable — it does not issue the request until
    // something subscribes to it. `void builder` type-checks, looks like
    // fire-and-forget, and silently never runs. It meant last_used_at stayed
    // null for every key despite constant use, which was only noticed once
    // the settings UI put that column on screen.
    pool()
      .query('update api_keys set last_used_at = now() where id = $1', [data.id])
      .then(
        () => undefined,
        () => undefined, // never let a failed touch fail the request
      )

    return {
      userId: data.user_id,
      actorType: 'agent',
      actorId: actorLabel('agent', data.agent_name, data.user_display_name),
      userDisplayName: data.user_display_name,
      role: data.role,
      rateKey: `key:${data.id}`,
    }
  }

  const user = await sessionUser()
  if (!user) return null

  return {
    userId: user.id,
    actorType: 'human',
    // Use the canonical display identity. `actorId` is stamped on every write
    // and shown in the activity trail, where a UUID answers nothing.
    actorId: actorLabel('human', user.email ?? user.id, user.displayName),
    userDisplayName: user.displayName,
    role: user.role,
    rateKey: `user:${user.id}`,
  }
}
