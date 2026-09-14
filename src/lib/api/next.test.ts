import { describe, expect, it } from 'vitest'
import { rankNext, type Candidate } from './next'

const NOW = Date.parse('2026-09-14T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString()

const task = (over: Partial<Candidate> & { ref: string }): Candidate => ({
  title: over.ref,
  status: 'backlog',
  priority: 'medium',
  updatedAt: hoursAgo(1),
  ...over,
})

const refs = (tasks: Candidate[], me: string | null = 'claude-code') =>
  rankNext(tasks, { me, now: NOW }).map((t) => t.ref)

describe('rankNext', () => {
  it('puts what you are already holding first', () => {
    const out = refs([
      task({ ref: 'A-1', status: 'todo', priority: 'urgent' }),
      task({ ref: 'A-2', status: 'doing', claimedBy: 'claude-code', heartbeatAt: hoursAgo(0) }),
    ])
    // Even against an urgent one: finishing beats starting.
    expect(out[0]).toBe('A-2')
  })

  it('prefers dropped work with a checkpoint over anything not started', () => {
    const out = refs([
      task({ ref: 'A-1', status: 'todo', priority: 'urgent' }),
      task({ ref: 'A-2', status: 'doing', checkpoint: 'got as far as the migration' }),
    ])
    expect(out[0]).toBe('A-2')
  })

  it('prefers a checkpoint over dropped work without one', () => {
    const out = refs([
      task({ ref: 'A-1', status: 'doing' }),
      task({ ref: 'A-2', status: 'doing', checkpoint: 'left mid-refactor' }),
    ])
    expect(out).toEqual(['A-2', 'A-1'])
  })

  it('never offers a blocked task', () => {
    expect(refs([task({ ref: 'A-1', status: 'todo', blockedAt: hoursAgo(2) })])).toEqual([])
  })

  it('never offers a task waiting on something unfinished', () => {
    // Absent rather than ranked last: a list that ends in things you must not
    // pick has to be read to the bottom before it can be used safely.
    expect(refs([task({ ref: 'A-1', status: 'todo', unmetDeps: 1 })])).toEqual([])
  })

  it('leaves alone what another agent is actively on', () => {
    expect(
      refs([task({ ref: 'A-1', status: 'doing', claimedBy: 'codex', heartbeatAt: hoursAgo(1) })]),
    ).toEqual([])
  })

  it('offers work whose claim has gone quiet, which is the point', () => {
    // A stale claim is exactly the abandoned work this exists to surface, so
    // the heartbeat decides rather than the claim.
    const out = refs([
      task({
        ref: 'A-1',
        status: 'doing',
        claimedBy: 'codex',
        heartbeatAt: hoursAgo(48),
        checkpoint: 'half done',
      }),
    ])
    expect(out).toEqual(['A-1'])
  })

  it('treats a claim with no heartbeat at all as somebody else working', () => {
    expect(refs([task({ ref: 'A-1', status: 'doing', claimedBy: 'codex' })])).toEqual([])
  })

  it('sorts by priority inside a tier', () => {
    const out = refs([
      task({ ref: 'A-1', status: 'todo', priority: 'low' }),
      task({ ref: 'A-2', status: 'todo', priority: 'urgent' }),
      task({ ref: 'A-3', status: 'todo', priority: 'high' }),
    ])
    expect(out).toEqual(['A-2', 'A-3', 'A-1'])
  })

  it('breaks a priority tie with the oldest, so nothing rots', () => {
    const out = refs([
      task({ ref: 'A-1', status: 'todo', updatedAt: hoursAgo(1) }),
      task({ ref: 'A-2', status: 'todo', updatedAt: hoursAgo(200) }),
    ])
    expect(out).toEqual(['A-2', 'A-1'])
  })

  it('says why, because a recommendation without one is not actionable', () => {
    const ranked = rankNext([task({ ref: 'A-1', status: 'doing', checkpoint: 'x' })], { now: NOW })
    expect(ranked[0]?.tier).toBe('checkpointed')
    expect(ranked[0]?.reason).toMatch(/wrote down where they got to/)
  })

  it('excludes finished work', () => {
    expect(
      refs([task({ ref: 'A-1', status: 'done' }), task({ ref: 'A-2', status: 'cancelled' })]),
    ).toEqual([])
  })
})
