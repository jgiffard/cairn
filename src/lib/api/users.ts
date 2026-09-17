import { hash } from 'bcryptjs'
import type { PoolClient } from 'pg'
import { pool, transaction } from '@/lib/db/client'
import type { UserRole } from './actor'
import { generateApiKey } from './keys'

export type AdminUser = {
  id: string
  email: string
  displayName: string
  role: UserRole
  active: boolean
  deletedAt: string | null
  bannedUntil: string | null
  createdAt: string
  updatedAt: string
  keyCount: number
  activeKeyCount: number
}

export class UserAdminError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'final_admin',
    message: string,
  ) {
    super(message)
  }
}

const selectUser = `
  select u.id, u.email,
         coalesce(nullif(trim(p.display_name), ''), u.email) as "displayName",
         u.role,
         (u.deleted_at is null and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()) as active,
         u.deleted_at as "deletedAt", u.banned_until as "bannedUntil",
         u.created_at as "createdAt", u.updated_at as "updatedAt",
         count(k.id)::int as "keyCount",
         count(k.id) filter (where k.revoked_at is null)::int as "activeKeyCount"
    from app_users u
    left join user_profiles p on p.id = u.id
    left join api_keys k on k.user_id = u.id`

const groupUser = `
  group by u.id, u.email, p.display_name, u.role, u.deleted_at, u.banned_until,
           u.created_at, u.updated_at`

const lockAdminInvariant = async (client: PoolClient) => {
  await client.query("select pg_advisory_xact_lock(hashtext('cairn:active-admin'))")
}

const activeAdminCount = async (client: PoolClient) => {
  const result = await client.query<{ count: number }>(
    `select count(*)::int as count from app_users
      where role = 'admin' and deleted_at is null
        and coalesce(banned_until, '-infinity'::timestamptz) <= now()`,
  )
  return result.rows[0]?.count ?? 0
}

const lockUser = async (client: PoolClient, id: string): Promise<void> => {
  const result = await client.query<{ id: string }>(
    'select id from app_users where id = $1 for update',
    [id],
  )
  if (!result.rows[0]) throw new UserAdminError('not_found', 'No such user.')
}

const userById = async (client: PoolClient, id: string): Promise<AdminUser> => {
  const result = await client.query<AdminUser>(`${selectUser} where u.id = $1 ${groupUser}`, [id])
  const user = result.rows[0]
  if (!user) throw new UserAdminError('not_found', 'No such user.')
  return user
}

export const listUsers = async (): Promise<AdminUser[]> => {
  const result = await pool().query<AdminUser>(`${selectUser} ${groupUser} order by u.created_at, u.id`)
  return result.rows
}

export const createUser = async (input: {
  email: string
  displayName: string
  password: string
  role: UserRole
}): Promise<AdminUser> => {
  const encryptedPassword = await hash(input.password, 12)
  try {
    return await transaction(async (client) => {
      const created = await client.query<{ id: string }>(
        `insert into app_users (email, encrypted_password, role)
         values ($1, $2, $3) returning id`,
        [input.email.trim(), encryptedPassword, input.role],
      )
      const id = created.rows[0]!.id
      await client.query(
        `insert into user_profiles (id, display_name) values ($1, $2)`,
        [id, input.displayName.trim() || null],
      )
      return userById(client, id)
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new UserAdminError('conflict', 'A user with that email already exists.')
    }
    throw error
  }
}

export const updateUser = async (
  id: string,
  input: { email?: string; displayName?: string; role?: UserRole },
): Promise<AdminUser> => {
  try {
    return await transaction(async (client) => {
      await lockAdminInvariant(client)
      const current = await userById(client, id)
      if (current.active && current.role === 'admin' && input.role === 'member' && await activeAdminCount(client) <= 1) {
        throw new UserAdminError('final_admin', 'The final active administrator cannot be demoted.')
      }
      if (input.email !== undefined || input.role !== undefined) {
        await client.query(
          `update app_users
              set email = coalesce($2, email), role = coalesce($3, role), updated_at = now()
            where id = $1`,
          [id, input.email?.trim() ?? null, input.role ?? null],
        )
      }
      if (input.displayName !== undefined) {
        await client.query(
          `insert into user_profiles (id, display_name) values ($1, $2)
           on conflict (id) do update set display_name = excluded.display_name, updated_at = now()`,
          [id, input.displayName.trim() || null],
        )
      }
      return userById(client, id)
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new UserAdminError('conflict', 'A user with that email already exists.')
    }
    throw error
  }
}

export const deactivateUser = async (id: string): Promise<AdminUser> => transaction(async (client) => {
  await lockAdminInvariant(client)
  await lockUser(client, id)
  const current = await userById(client, id)
  if (current.deletedAt) return current
  if (current.role === 'admin' && await activeAdminCount(client) <= 1) {
    throw new UserAdminError('final_admin', 'The final active administrator cannot be disabled.')
  }
  await client.query(
    `update app_users
        set deleted_at = now(),
            auth_epoch = auth_epoch + 1,
            session_epoch = session_epoch + 1,
            updated_at = now()
      where id = $1`,
    [id],
  )
  await client.query('delete from app_sessions where user_id = $1', [id])
  await client.query('update api_keys set revoked_at = now() where user_id = $1 and revoked_at is null', [id])
  return userById(client, id)
})

export const restoreUser = async (id: string): Promise<AdminUser> => transaction(async (client) => {
  await lockAdminInvariant(client)
  await userById(client, id)
  await client.query(
    'update app_users set deleted_at = null, banned_until = null, updated_at = now() where id = $1',
    [id],
  )
  return userById(client, id)
})

export const resetUserPassword = async (id: string, password: string): Promise<void> => {
  const encryptedPassword = await hash(password, 12)
  await transaction(async (client) => {
    await userById(client, id)
    await client.query(
      `update app_users
          set encrypted_password = $2,
              session_epoch = session_epoch + 1,
              updated_at = now()
        where id = $1`,
      [id, encryptedPassword],
    )
    await client.query('delete from app_sessions where user_id = $1', [id])
  })
}

export const listUserKeys = async (userId: string) => {
  await pool().query('select id from app_users where id = $1', [userId]).then((result) => {
    if (!result.rows[0]) throw new UserAdminError('not_found', 'No such user.')
  })
  const result = await pool().query(
    `select id, agent_name, name, key_prefix, last_used_at, revoked_at, created_at
       from api_keys where user_id = $1 order by created_at, id`,
    [userId],
  )
  return result.rows
}

export const createUserKey = async (userId: string, input: { agentName: string; name: string }) => {
  const generated = generateApiKey()
  return transaction(async (client) => {
    await lockUser(client, userId)
    const user = await userById(client, userId)
    if (!user.active) throw new UserAdminError('conflict', 'Keys cannot be created for an inactive user.')
    const result = await client.query(
      `insert into api_keys (user_id, agent_name, platform_source, name, key_prefix, key_hash, auth_epoch)
       select id, $2, $2, $3, $4, $5, auth_epoch
         from app_users
        where id = $1 and deleted_at is null
          and coalesce(banned_until, '-infinity'::timestamptz) <= now()
       returning id, agent_name, name, key_prefix, created_at`,
      [userId, input.agentName, input.name, generated.keyPrefix, generated.keyHash],
    )
    const created = result.rows[0]
    if (!created) {
      throw new UserAdminError('conflict', 'The user became inactive before the key was created.')
    }
    return {
      ...created,
      key: generated.key,
      warning: 'This is the only time the key is shown. Store it now.',
    }
  })
}

export const revokeUserKey = async (userId: string, keyId: string) => {
  const result = await pool().query(
    `update api_keys set revoked_at = now()
      where id = $1 and user_id = $2 and revoked_at is null
      returning id, agent_name, revoked_at`,
    [keyId, userId],
  )
  const key = result.rows[0]
  if (!key) throw new UserAdminError('not_found', 'No such active key.')
  return key
}
