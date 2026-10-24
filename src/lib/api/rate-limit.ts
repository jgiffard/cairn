/**
 * Per-session token buckets under a per-key ceiling, held in process memory.
 * A machine's many agent sessions share one API key: each needs its own budget,
 * while the key ceiling still bounds runaway loops (such as the Drove factory
 * error loop that hit Cairn 318 times in eight hours).
 *
 * Cairn runs as a single container. With multiple replicas these limits become
 * per-replica, which is the point at which to move the buckets to a shared store.
 */
type Bucket = { tokens: number; updatedAt: number }

export type RateLimitConfig = {
  burst: number
  perSecond: number
  keyBurst: number
  keyPerSecond: number
}

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const rateLimitConfigFromEnv = (env: Record<string, string | undefined>): RateLimitConfig => {
  const burst = positive(env.CAIRN_RATE_BURST, 600)
  const perSecond = positive(env.CAIRN_RATE_PER_SECOND, 10)
  return {
    burst,
    perSecond,
    keyBurst: positive(env.CAIRN_RATE_KEY_BURST, burst * 5),
    keyPerSecond: positive(env.CAIRN_RATE_KEY_PER_SECOND, perSecond * 5),
  }
}

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfter: number }

export const createRateLimiter = ({
  burst,
  perSecond,
  keyBurst,
  keyPerSecond,
  now = Date.now,
}: RateLimitConfig & { now?: () => number }) => {
  const sessions = new Map<string, Bucket>()
  const keys = new Map<string, Bucket>()
  let calls = 0

  const refill = (bucket: Bucket | undefined, capacity: number, rate: number, time: number): Bucket => {
    if (!bucket) return { tokens: capacity, updatedAt: time }
    // Keep the old timestamp on a backwards step, too: recovering the clock
    // must not refill the same interval twice.
    const updatedAt = Math.max(time, bucket.updatedAt)
    return {
      tokens: Math.min(capacity, bucket.tokens + (updatedAt - bucket.updatedAt) / 1000 * rate),
      updatedAt,
    }
  }

  const prune = (buckets: Map<string, Bucket>, refillTime: number, time: number) => {
    for (const [id, bucket] of buckets) {
      // No successful request for an entire refill period: this bucket would
      // be full, so forgetting it cannot give the caller extra tokens.
      if (time - bucket.updatedAt > refillTime) buckets.delete(id)
    }
  }

  return {
    // Useful for checking that rotating identities do not retain idle buckets.
    get bucketCount() { return sessions.size + keys.size },
    checkRateLimit(rateKey: string, sessionId?: string | null): RateLimitResult {
      const time = now()
      if (++calls % 256 === 0) {
        prune(sessions, burst / perSecond * 1000, time)
        prune(keys, keyBurst / keyPerSecond * 1000, time)
      }
      const sessionKey = `${rateKey}|${sessionId ?? '-'}`
      const session = refill(sessions.get(sessionKey), burst, perSecond, time)
      const key = refill(keys.get(rateKey), keyBurst, keyPerSecond, time)

      if (session.tokens < 1 || key.tokens < 1) {
        return {
          allowed: false,
          remaining: 0,
          retryAfter: Math.max(1, Math.ceil(Math.max(
            (1 - session.tokens) / perSecond,
            (1 - key.tokens) / keyPerSecond,
          ))),
        }
      }

      // Synchronous check and commit: a refusal consumes nothing from either
      // bucket, and a new session refused by the key ceiling is never stored.
      sessions.set(sessionKey, { tokens: session.tokens - 1, updatedAt: session.updatedAt })
      keys.set(rateKey, { tokens: key.tokens - 1, updatedAt: key.updatedAt })
      return { allowed: true, remaining: Math.floor(Math.min(session.tokens - 1, key.tokens - 1)), retryAfter: 0 }
    },
  }
}

// Read once at module load; operators apply env changes by restarting Cairn.
export const { checkRateLimit } = createRateLimiter(rateLimitConfigFromEnv(process.env))
