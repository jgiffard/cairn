import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'
import { createUserKey, listUserKeys } from '@/lib/api/users'

export const dynamic = 'force-dynamic'

const createKey = z.object({
  agentName: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes, e.g. claude-code'),
  name: z.string().min(1).max(100),
})

export const GET = route({
  handler: async ({ actor }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await listUserKeys(actor.userId))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

/**
 * One key per agent, so writes are attributable and any single agent can be
 * revoked without disturbing the others. The plaintext is returned exactly
 * once, here, and never stored.
 */
export const POST = route<Record<string, string>, z.infer<typeof createKey>>({
  schema: createKey,
  handler: async ({ actor, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await createUserKey(actor.userId, body), { status: 201 })
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
