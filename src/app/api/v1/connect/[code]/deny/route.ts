import { denyConnectRequest } from '@/lib/api/connect'
import { connectFailure, requireHumanActor } from '@/lib/api/connect-route'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'

export const POST = route<{ code: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireHumanActor(actor)
    if (denied) return denied
    try {
      await denyConnectRequest(params.code)
      return ok({ denied: true })
    } catch (error) {
      return connectFailure(error)
    }
  },
})
