import { describe, expect, it } from 'vitest'
import { isTrustedMutationOrigin } from './handler'

const request = (method: string, headers?: HeadersInit) =>
  new Request('https://cairn.example.test/api/v1/users', { method, headers })

describe('browser mutation origin', () => {
  it('allows safe reads without an origin', () => {
    expect(isTrustedMutationOrigin(request('GET'))).toBe(true)
  })

  it('allows bearer mutations without browser origin metadata', () => {
    expect(isTrustedMutationOrigin(request('POST', { authorization: 'Bearer sk_live_test' }))).toBe(true)
  })

  it('allows same-origin browser mutations', () => {
    expect(isTrustedMutationOrigin(request('POST', { origin: 'https://cairn.example.test' }))).toBe(true)
  })

  it('rejects missing and sibling origins for cookie-authenticated mutations', () => {
    expect(isTrustedMutationOrigin(request('POST'))).toBe(false)
    expect(
      isTrustedMutationOrigin(request('POST', { origin: 'https://evil.example.test' })),
    ).toBe(false)
  })
})
