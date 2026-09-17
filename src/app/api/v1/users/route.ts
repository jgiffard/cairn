import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { USER_ROLES } from '@/lib/api/actor'
import { createUser, listUsers } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

export const dynamic = 'force-dynamic'

const createUserSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(1024),
  role: z.enum(USER_ROLES).default('member'),
})

export const GET = route({
  handler: async ({ actor }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    return ok(await listUsers())
  },
})

export const POST = route<Record<string, string>, z.infer<typeof createUserSchema>>({
  schema: createUserSchema,
  handler: async ({ actor, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await createUser(body), { status: 201 })
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
