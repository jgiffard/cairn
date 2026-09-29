import { z } from 'zod'
import { approveConnectRequest, RUNTIME_PATTERN } from '@/lib/api/connect'
import { connectFailure, requireHumanActor } from '@/lib/api/connect-route'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'

const approveSchema = z.object({
  runtimes: z.array(z.string().regex(RUNTIME_PATTERN)).min(1).max(6),
})

/**
 * Browser-session only (`route()`'s cookie/bearer split plus the human check
 * below), and origin-checked the same as every other cookie-authenticated
 * mutation — see `isTrustedMutationOrigin` in handler.ts. Keys are minted
 * later, at poll time, not here: approving only records what was allowed.
 */
export const POST = route<{ code: string }, z.infer<typeof approveSchema>>({
  schema: approveSchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireHumanActor(actor)
    if (denied) return denied
    try {
      await approveConnectRequest(params.code, { runtimes: body.runtimes, approvedBy: actor.userId, approverRole: actor.role })
      return ok({ approved: true })
    } catch (error) {
      return connectFailure(error)
    }
  },
})
