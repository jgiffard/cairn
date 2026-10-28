import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), checkRateLimit: vi.fn() }))
vi.mock('./auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('./rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }))

import { route } from './handler'
import { VERSION_HEADER } from './response'
import { BUILT_AT, BUILT_AT_HEADER, CLI_FINGERPRINT, CLI_HEADER } from './cli-fingerprint'
import { version } from '../../../package.json'

const actor = {
  userId: 'user-1', actorType: 'agent', actorId: 'codex · Cal',
  userDisplayName: 'Cal', role: 'admin', rateKey: 'key:agent-1', sessionId: 'session-1',
}
const handler = vi.fn(async () => new Response('{}'))
const GET = route({ handler })
const send = () => GET(new Request('https://cairn.example.test/api/v1/tasks'), { params: Promise.resolve({}) })

describe('route rate limiting (CAIRN-432)', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.checkRateLimit.mockReset().mockReturnValue({ allowed: true, remaining: 599, retryAfter: 0 })
    handler.mockClear()
  })

  it.each([1, 3, 17])('returns Retry-After equal to JSON retryAfter (%i seconds) and keeps version headers', async retryAfter => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfter })
    const response = await send()
    const body = await response.json()
    expect(response.status).toBe(429)
    expect(body).toMatchObject({ success: false, code: 'rate_limited', retryAfter })
    expect(response.headers.get('Retry-After')).toBe(String(body.retryAfter))
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    expect(response.headers.get(VERSION_HEADER)).toBe(version)
    if (CLI_FINGERPRINT) expect(response.headers.get(CLI_HEADER)).toBe(CLI_FINGERPRINT)
    if (BUILT_AT) expect(response.headers.get(BUILT_AT_HEADER)).toBe(BUILT_AT)
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes the authenticated rate key and session to the limiter', async () => {
    expect((await send()).status).toBe(200)
    expect(mocks.checkRateLimit).toHaveBeenCalledOnce()
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(actor.rateKey, actor.sessionId)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('passes a null session for callers without a session header', async () => {
    mocks.authenticate.mockResolvedValue({ ...actor, sessionId: null })
    expect((await send()).status).toBe(200)
    expect(mocks.checkRateLimit).toHaveBeenCalledOnce()
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(actor.rateKey, null)
  })
})
