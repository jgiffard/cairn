import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createUserKey, listUserKeys } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

const createKeySchema = z.object({
  agentName: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(100),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await listUserKeys(params.id))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

export const POST = route<{ id: string }, z.infer<typeof createKeySchema>>({
  schema: createKeySchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await createUserKey(params.id, body), { status: 201 })
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
