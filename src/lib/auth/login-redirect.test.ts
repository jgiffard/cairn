import { describe, expect, it } from 'vitest'
import { loginUrlFor, safeRedirect } from './login-redirect'

describe('login redirects', () => {
  it('keeps a same-site destination, query included', () => {
    expect(loginUrlFor('/connect/WNWK-TX7P')).toBe('/login?redirect=%2Fconnect%2FWNWK-TX7P')
    expect(safeRedirect('/search?q=x')).toBe('/search?q=x')
  })

  it('refuses anything a browser would read as another host', () => {
    const hostile = ['//evil.test', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', '/\r\\evil.test', 'https://evil.test', 'evil.test']
    for (const value of hostile) expect(safeRedirect(value)).toBe('/')
  })

  it('sends a bare /login when there is nowhere to return to', () => {
    expect(loginUrlFor(null)).toBe('/login')
    expect(loginUrlFor('/')).toBe('/login')
  })
})
