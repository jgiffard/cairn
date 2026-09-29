import { describe, expect, it } from 'vitest'
import { groupKeysByHost, hostOfKey, OTHER_HOST } from './agent-key-hosts'

const key = (agentName: string, name: string, createdAt = '2026-09-01T00:00:00Z') => ({ agentName, name, createdAt })

describe('hostOfKey', () => {
  it('reads the host from a paired key name', () => {
    expect(hostOfKey(key('claude-code', 'claude-code on cal-mbp.local'))).toBe('cal-mbp.local')
  })

  it('refuses a name whose runtime is not the key\'s own agent', () => {
    expect(hostOfKey(key('codex', 'claude-code on cal-mbp'))).toBeNull()
  })

  it('refuses a hand-typed name', () => {
    expect(hostOfKey(key('codex', 'Workstation key'))).toBeNull()
    expect(hostOfKey(key('codex', 'codex on my laptop'))).toBeNull()
  })
})

describe('groupKeysByHost', () => {
  it('groups by host, newest host first, and puts the rest under Other, last', () => {
    const groups = groupKeysByHost([
      key('codex', 'Workstation key', '2026-09-20T00:00:00Z'),
      key('claude-code', 'claude-code on old-box', '2026-08-01T00:00:00Z'),
      key('claude-code', 'claude-code on laptop', '2026-09-10T00:00:00Z'),
      key('codex', 'codex on laptop', '2026-09-10T00:00:01Z'),
    ])
    expect(groups.map((g) => [g.host, g.keys.length])).toEqual([
      ['laptop', 2],
      ['old-box', 1],
      [OTHER_HOST, 1],
    ])
  })

  it('does not merge a machine called "Other" with the unpaired keys', () => {
    const groups = groupKeysByHost([key('codex', 'codex on Other'), key('codex', 'hand-made')])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.paired)).toEqual([true, false])
  })
})
