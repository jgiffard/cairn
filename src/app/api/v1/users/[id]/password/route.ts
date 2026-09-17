import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { resetUserPassword } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

const passwordSchema = z.object({ password: z.string().min(12).max(1024) })

export const POST = route<{ id: string }, z.infer<typeof passwordSchema>>({
  schema: passwordSchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      await resetUserPassword(params.id, body.password)
      return ok({ reset: true, sessionsRevoked: true })
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})
