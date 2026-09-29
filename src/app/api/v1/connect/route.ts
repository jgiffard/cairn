import { z } from 'zod'
import { clientAddress } from '@/lib/api/client-address'
import { createConnectRequest, RUNTIME_PATTERN } from '@/lib/api/connect'
import { servedOrigin } from '@/lib/api/handler'
import { fail, failValidation, ok } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  host: z.string().trim().min(1).max(100),
  runtimes: z.array(z.string().regex(RUNTIME_PATTERN)).min(1).max(6),
  cliVersion: z.string().trim().min(1).max(100).optional(),
})

/**
 * A machine with no credentials asks for some, the same shape as OAuth 2.0's
 * device authorization grant. `route()` always requires an actor, so this
 * bypasses it — the same way /api/auth/login and /api/v1/health do — and is
 * the one endpoint in this file whose job is to be reachable without one.
 */
const WINDOW_MS = 10 * 60_000
const MAX_PER_ADDRESS = 10
const attempts = new Map<string, { count: number; resetAt: number }>()

const rateLimited = (address: string, now: number): boolean => {
  const current = attempts.get(address)
  return Boolean(current && current.resetAt > now && current.count >= MAX_PER_ADDRESS)
}

const recordAttempt = (address: string, now: number) => {
  const current = attempts.get(address)
  attempts.set(address, { count: current && current.resetAt > now ? current.count + 1 : 1, resetAt: now + WINDOW_MS })
}

export const POST = async (req: Request): Promise<Response> => {
  const address = clientAddress(req.headers)
  const now = Date.now()
  if (rateLimited(address, now)) {
    return fail('rate_limited', 'Too many pairing requests from this address. Try again later.', {
      retryAfter: Math.ceil(WINDOW_MS / 1000),
    })
  }
  recordAttempt(address, now)

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return failValidation(parsed.error.issues)

  try {
    // CAIRN_BASE_URL first, same variable the CLI and layout.tsx already use
    // for "the public URL of this instance" — it is the only correct answer
    // behind a reverse proxy with no public hostname of its own to report.
    // Falling back to the request's served origin (the same origin CSRF
    // protection trusts, in handler.ts) covers a bare local/dev deployment.
    const baseUrl = (process.env.CAIRN_BASE_URL || servedOrigin(req)).replace(/\/+$/, '')
    const created = await createConnectRequest({
      host: parsed.data.host,
      runtimes: [...new Set(parsed.data.runtimes)],
      cliVersion: parsed.data.cliVersion,
      clientAddress: address,
      baseUrl,
    })
    return ok(created, { status: 201 })
  } catch (error) {
    console.error('[api] connect create failed', error)
    return fail('internal_error', 'Something went wrong.')
  }
}
