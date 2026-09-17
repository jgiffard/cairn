import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { USER_ROLES } from '@/lib/api/actor'
import { deactivateUser, updateUser } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

export const dynamic = 'force-dynamic'

const updateUserSchema = z.object({
  email: z.string().email().max(320).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  role: z.enum(USER_ROLES).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required.')

export const PATCH = route<{ id: string }, z.infer<typeof updateUserSchema>>({
  schema: updateUserSchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await updateUser(params.id, body))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await deactivateUser(params.id))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
