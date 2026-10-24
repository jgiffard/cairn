import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter, rateLimitConfigFromEnv, type RateLimitConfig } from './rate-limit'

const defaults = rateLimitConfigFromEnv({})
const clocked = (config: Partial<RateLimitConfig> = {}) => {
  let time = 0
  const limiter = createRateLimiter({ ...defaults, ...config, now: () => time })
  return { limiter, at: (value: number) => { time = value } }
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe('session rate limits under a key ceiling (CAIRN-432)', () => {
  it('allows 20 sessions sharing a key at 60 requests per minute each for five minutes', () => {
    const { limiter, at } = clocked()
    for (let second = 0; second < 300; second++) {
      at(second * 1000)
      for (let session = 0; session < 20; session++) {
        expect(limiter.checkRateLimit('shared-key', `session-${session}`).allowed).toBe(true)
      }
    }
  })

  it('refuses a looping session while allowing other sessions on its key', () => {
    const { limiter } = clocked()
    for (let i = 0; i < 600; i++) expect(limiter.checkRateLimit('key', 'loop').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'loop')).toMatchObject({ allowed: false, retryAfter: 1 })
    for (let i = 0; i < 20; i++) expect(limiter.checkRateLimit('key', `other-${i}`).allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'loop').allowed).toBe(false)
  })

  it('uses configured session burst and refill values', () => {
    const config = rateLimitConfigFromEnv({ CAIRN_RATE_BURST: '3', CAIRN_RATE_PER_SECOND: '2' })
    expect(config).toEqual({ burst: 3, perSecond: 2, keyBurst: 15, keyPerSecond: 10 })
    const { limiter, at } = clocked(config)
    for (let i = 0; i < 3; i++) expect(limiter.checkRateLimit('key', 'session').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'session').allowed).toBe(false)
    at(499)
    expect(limiter.checkRateLimit('key', 'session').allowed).toBe(false)
    at(500)
    expect(limiter.checkRateLimit('key', 'session').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'session').allowed).toBe(false)
    at(10_000)
    for (let i = 0; i < 3; i++) expect(limiter.checkRateLimit('key', 'session').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'session').allowed).toBe(false)
  })

  it('uses configured key burst and refill values even when sessions have tokens', () => {
    const config = rateLimitConfigFromEnv({
      CAIRN_RATE_BURST: '10', CAIRN_RATE_PER_SECOND: '2',
      CAIRN_RATE_KEY_BURST: '3', CAIRN_RATE_KEY_PER_SECOND: '4',
    })
    expect(config).toEqual({ burst: 10, perSecond: 2, keyBurst: 3, keyPerSecond: 4 })
    const { limiter, at } = clocked(config)
    for (const id of ['a', 'b', 'c']) expect(limiter.checkRateLimit('key', id).allowed).toBe(true)
    for (const id of ['a', 'b', 'c', 'new']) expect(limiter.checkRateLimit('key', id).allowed).toBe(false)
    expect(limiter.checkRateLimit('different-key', 'a').allowed).toBe(true)
    at(249)
    expect(limiter.checkRateLimit('key', 'new').allowed).toBe(false)
    at(250)
    expect(limiter.checkRateLimit('key', 'new').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(false)
  })

  it('reads all four env values once when the module loads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubEnv('CAIRN_RATE_BURST', '2')
    vi.stubEnv('CAIRN_RATE_PER_SECOND', '0.5')
    vi.stubEnv('CAIRN_RATE_KEY_BURST', '3')
    vi.stubEnv('CAIRN_RATE_KEY_PER_SECOND', '0.25')
    vi.resetModules()
    const { checkRateLimit } = await import('./rate-limit')
    vi.stubEnv('CAIRN_RATE_BURST', '9999')
    expect(checkRateLimit('env-key', 'a').allowed).toBe(true)
    expect(checkRateLimit('env-key', 'a').allowed).toBe(true)
    expect(checkRateLimit('env-key', 'a').allowed).toBe(false)
    expect(checkRateLimit('env-key', 'b').allowed).toBe(true)
    expect(checkRateLimit('env-key', 'c')).toMatchObject({ allowed: false, retryAfter: 4 })
    vi.setSystemTime(2000)
    expect(checkRateLimit('env-key', 'a')).toMatchObject({ allowed: false, retryAfter: 2 })
    vi.setSystemTime(4000)
    expect(checkRateLimit('env-key', 'a').allowed).toBe(true)
    expect(checkRateLimit('env-key', 'a').allowed).toBe(false)
  })

  it.each([undefined, '', ' ', 'wat', '0', '-1', 'NaN', 'Infinity'])('keeps limits in force for invalid env value %s', value => {
    const config = rateLimitConfigFromEnv({
      CAIRN_RATE_BURST: value, CAIRN_RATE_PER_SECOND: value,
      CAIRN_RATE_KEY_BURST: value, CAIRN_RATE_KEY_PER_SECOND: value,
    })
    expect(config).toEqual({ burst: 600, perSecond: 10, keyBurst: 3000, keyPerSecond: 50 })
    const { limiter } = clocked(config)
    for (let i = 0; i < 600; i++) expect(limiter.checkRateLimit('key').allowed).toBe(true)
    expect(limiter.checkRateLimit('key').allowed).toBe(false)
  })

  it('falls back to five times the configured session values for invalid key values', () => {
    expect(rateLimitConfigFromEnv({
      CAIRN_RATE_BURST: '7', CAIRN_RATE_PER_SECOND: '0.5',
      CAIRN_RATE_KEY_BURST: '-3', CAIRN_RATE_KEY_PER_SECOND: 'bad',
    })).toEqual({ burst: 7, perSecond: 0.5, keyBurst: 35, keyPerSecond: 2.5 })
  })

  it('returns whole seconds until both refusing buckets have a token', () => {
    const { limiter, at } = clocked({ burst: 1, perSecond: 0.5, keyBurst: 1, keyPerSecond: 0.25 })
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'a').retryAfter).toBe(4)
    at(1500)
    expect(limiter.checkRateLimit('key', 'a').retryAfter).toBe(3)
    at(3999)
    expect(limiter.checkRateLimit('key', 'a').retryAfter).toBe(1)
    at(4000)
    expect(limiter.checkRateLimit('key', 'a')).toEqual({ allowed: true, remaining: 0, retryAfter: 0 })
  })

  it.each([
    ['a', 'a', 'a', 'b', 'b', 'c'],
    ['a', 'b', 'a', 'c', 'b', 'a'],
    ['c', 'b', 'b', 'a', 'a', 'a'],
  ])('commits exactly one token per allowed interleaved request in order %j', (...order) => {
    const { limiter } = clocked({ burst: 2, keyBurst: 3 })
    const accepted: Record<string, number> = {}
    for (const id of order) {
      const result = limiter.checkRateLimit('key', id)
      expect(result).not.toBeInstanceOf(Promise)
      if (result.allowed) accepted[id] = (accepted[id] ?? 0) + 1
    }
    expect(Object.values(accepted).reduce((sum, count) => sum + count, 0)).toBe(3)
    expect(Object.values(accepted).every(count => count <= 2)).toBe(true)
  })

  it('does not consume key tokens when a session refuses a request', () => {
    const { limiter } = clocked({ burst: 1, keyBurst: 3 })
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(true)
    for (let i = 0; i < 10; i++) expect(limiter.checkRateLimit('key', 'a').allowed).toBe(false)
    expect(limiter.checkRateLimit('key', 'b').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'c').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'd').allowed).toBe(false)
  })

  it('does not consume session tokens when the key refuses a request', () => {
    const { limiter, at } = clocked({ burst: 2, perSecond: 0.01, keyBurst: 2, keyPerSecond: 1 })
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(true)
    for (let i = 0; i < 10; i++) expect(limiter.checkRateLimit('key', 'b').allowed).toBe(false)
    at(1000)
    expect(limiter.checkRateLimit('key', 'b').allowed).toBe(true)
    at(2000)
    expect(limiter.checkRateLimit('key', 'b').allowed).toBe(true)
    at(3000)
    expect(limiter.checkRateLimit('key', 'b').allowed).toBe(false)
    expect(limiter.checkRateLimit('key', 'c').allowed).toBe(true)
  })

  it('shares one fallback bucket for requests without a session', () => {
    const { limiter } = clocked({ burst: 2 })
    expect(limiter.checkRateLimit('key').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', null).allowed).toBe(true)
    expect(limiter.checkRateLimit('key').allowed).toBe(false)
    expect(limiter.checkRateLimit('key', 'explicit-session').allowed).toBe(true)
  })

  it('bounds rotating session ids by the key ceiling and prunes idle buckets', () => {
    const { limiter, at } = clocked()
    let allowed = 0
    for (let i = 0; i < 10_000; i++) {
      if (limiter.checkRateLimit('key', `rotation-${i}`).allowed) allowed++
    }
    expect(allowed).toBe(3000)
    expect(limiter.bucketCount).toBe(3001)
    at(60_001)
    for (let i = 0; i < 256; i++) expect(limiter.checkRateLimit('active-key', 'active').allowed).toBe(true)
    expect(limiter.bucketCount).toBe(2)
    expect(limiter.checkRateLimit('key', 'rotation-0').allowed).toBe(true)
    expect(limiter.bucketCount).toBe(4)
  })

  it('preserves tokens on a backwards clock step without double refill on recovery', () => {
    const { limiter, at } = clocked({ burst: 3, perSecond: 1, keyBurst: 3, keyPerSecond: 1 })
    at(1000)
    expect(limiter.checkRateLimit('key', 'a').remaining).toBe(2)
    at(0)
    expect(limiter.checkRateLimit('key', 'a').remaining).toBe(1)
    expect(limiter.checkRateLimit('key', 'a').remaining).toBe(0)
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(false)
    at(1000)
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(false)
    at(2000)
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(true)
    expect(limiter.checkRateLimit('key', 'a').allowed).toBe(false)
  })
})
