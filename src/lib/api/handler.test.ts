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

/**
 * Behind a proxy that terminates TLS — the deployment the README documents —
 * the application receives a plaintext request while the browser announces an
 * https origin. Comparing against the request's own URL can then never match,
 * and every browser write is refused.
 */
describe('browser mutation origin, behind a reverse proxy', () => {
  // What the container actually receives once Traefik has terminated TLS.
  const derriereProxy = (headers: HeadersInit) =>
    new Request('http://cairn.example.test/api/v1/users', { method: 'POST', headers })

  it('accepts the browser origin when the proxy says the hop was https', () => {
    expect(
      isTrustedMutationOrigin(
        derriereProxy({ origin: 'https://cairn.example.test', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe(true)
  })

  it('accepts a host rewritten by the proxy', () => {
    expect(
      isTrustedMutationOrigin(
        new Request('http://cairn-interne:3000/api/v1/users', {
          method: 'POST',
          headers: {
            origin: 'https://cairn.example.test',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'cairn.example.test',
          },
        }),
      ),
    ).toBe(true)
  })

  it('still refuses a foreign origin, proxy headers or not', () => {
    // Le point à ne pas casser : honorer les en-têtes de proxy ne doit pas
    // transformer le contrôle en formalité.
    expect(
      isTrustedMutationOrigin(
        derriereProxy({ origin: 'https://evil.example.test', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe(false)
  })

  it('takes only the first hop when a chain of proxies appends its own', () => {
    // X-Forwarded-* is a comma-separated list; the first entry is the client's.
    expect(
      isTrustedMutationOrigin(
        derriereProxy({ origin: 'https://cairn.example.test', 'x-forwarded-proto': 'https, http' }),
      ),
    ).toBe(true)
  })
})
