import { describe, expect, it } from 'vitest'
import { actorLabel, canAdministerUsers } from './actor'

describe('actor identity', () => {
  it('qualifies an agent with its owning user', () => {
    expect(actorLabel('agent', 'ClawClaw', 'Julien')).toBe('ClawClaw · Julien')
  })

  it('does not qualify an already canonical agent identity twice', () => {
    expect(actorLabel('agent', 'ClawClaw · Julien', 'Julien')).toBe('ClawClaw · Julien')
  })

  it('uses the user display name for a human actor', () => {
    expect(actorLabel('human', 'julien@example.test', 'Julien')).toBe('Julien')
  })

  it('falls back without producing an empty label', () => {
    expect(actorLabel('agent', 'Codex', null)).toBe('Codex')
    expect(actorLabel('human', 'julien@example.test', null)).toBe('julien@example.test')
  })

  it('allows only human administrators to manage users', () => {
    expect(canAdministerUsers({ actorType: 'human', role: 'admin' })).toBe(true)
    expect(canAdministerUsers({ actorType: 'agent', role: 'admin' })).toBe(false)
    expect(canAdministerUsers({ actorType: 'human', role: 'member' })).toBe(false)
  })
})
