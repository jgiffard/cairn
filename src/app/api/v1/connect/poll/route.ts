import { z } from 'zod'
import { pollConnectRequest } from '@/lib/api/connect'
import { fail, failValidation, ok } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ deviceCode: z.string().min(1).max(200) })

/**
 * Unauthenticated, like POST /connect: the whole point is that the caller
 * has no key yet. An unknown or malformed device code answers `expired`
 * rather than any shape that would say whether it ever existed.
 */
export const POST = async (req: Request): Promise<Response> => {
  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return failValidation(parsed.error.issues)

  try {
    return ok(await pollConnectRequest(parsed.data.deviceCode))
  } catch (error) {
    console.error('[api] connect poll failed', error)
    return fail('internal_error', 'Something went wrong.')
  }
}
