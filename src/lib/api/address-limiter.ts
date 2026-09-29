/**
 * A fixed-window counter per client address, for the endpoints that have to
 * answer with no credentials at all and so cannot use `route()`'s per-actor
 * limit. In memory and per process, like the login limiter: a restart forgets
 * it, which only ever errs towards letting someone in.
 *
 * Swept as it grows, so an address that came once and left does not stay in
 * the map for the life of the process.
 */
export const addressLimiter = ({ windowMs, max }: { windowMs: number; max: number }) => {
  const windows = new Map<string, { count: number; resetAt: number }>()

  const sweep = (now: number) => {
    if (windows.size < 1_000) return
    for (const [address, window] of windows) if (window.resetAt <= now) windows.delete(address)
  }

  /** Counts this request and says whether it is over the limit. */
  const hit = (address: string, now = Date.now()): boolean => {
    sweep(now)
    const current = windows.get(address)
    if (current && current.resetAt > now) {
      if (current.count >= max) return true
      current.count += 1
      return false
    }
    windows.set(address, { count: 1, resetAt: now + windowMs })
    return false
  }

  return { hit, retryAfterSeconds: Math.ceil(windowMs / 1000) }
}
