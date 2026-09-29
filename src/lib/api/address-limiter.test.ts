import { describe, expect, it } from 'vitest'
import { addressLimiter } from './address-limiter'

describe('addressLimiter', () => {
  it('lets max requests through per window, then refuses until it resets', () => {
    const limiter = addressLimiter({ windowMs: 1_000, max: 2 })
    expect([limiter.hit('a', 0), limiter.hit('a', 10), limiter.hit('a', 20)]).toEqual([false, false, true])
    expect(limiter.hit('b', 20)).toBe(false)
    expect(limiter.hit('a', 1_001)).toBe(false)
  })
})
