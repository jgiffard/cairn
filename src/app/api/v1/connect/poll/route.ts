import { z } from 'zod'
import { addressLimiter } from '@/lib/api/address-limiter'
import { clientAddress } from '@/lib/api/client-address'
import { pollConnectRequest } from '@/lib/api/connect'
import { fail, failValidation, ok } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

/** 32 random bytes, base64url: exactly what POST /connect hands out, nothing else. */
const bodySchema = z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })

/**
 * Unauthenticated, like POST /connect: the whole point is that the caller
 * has no key yet. An unknown or malformed device code answers `expired`
 * rather than any shape that would say whether it ever existed.
 */
/**
 * Every poll opens a transaction, so an unauthenticated flood would drain the
 * connection pool for the whole app. An honest CLI polls every 3s for at most
 * the 10-minute life of a code, about 200 times; this allows several machines
 * pairing at once behind one office address, and nothing like a flood.
 */
const limiter = addressLimiter({ windowMs: 10 * 60_000, max: 600 })

export const POST = async (req: Request): Promise<Response> => {
  if (limiter.hit(clientAddress(req.headers))) {
    return fail('rate_limited', 'Too many polls from this address. Slow down.', {
      retryAfter: limiter.retryAfterSeconds,
    })
  }
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
