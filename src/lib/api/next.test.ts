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

/**
 * Two sessions, one label.
 *
 * `claimedBy` is an actorLabel and every Claude Code session on a machine
 * writes the same one. Comparing it alone did not merely fail to skip a
 * sibling's live claim — it promoted the task to the `holding` tier and told
 * the caller "you are holding this one — finish it or hand it back". A session
 * working on a trading bot was sent to finish a knowledge-map task it had
 * never opened.
 */
describe('rankNext across concurrent sessions', () => {
  const held = (session: string | null) =>
    task({
      ref: 'A-1',
      status: 'doing',
      claimedBy: 'claude-code',
      claimedSession: session,
      heartbeatAt: hoursAgo(0),
    })

  it('does not offer a live claim held by another session of the same agent', () => {
    const out = rankNext([held('other-session')], {
      me: 'claude-code',
      now: NOW,
      mySession: 'my-session',
    })
    expect(out).toEqual([])
  })

  it('still puts this sessions own claim first', () => {
    const out = rankNext([held('my-session'), task({ ref: 'A-2', status: 'todo', priority: 'urgent' })], {
      me: 'claude-code',
      now: NOW,
      mySession: 'my-session',
    })
    expect(out[0]?.ref).toBe('A-1')
    expect(out[0]?.tier).toBe('holding')
  })

  it('treats a claim that names no session as the callers own, as before', () => {
    // Claimed before the column existed, or by a runtime that cannot name
    // itself. "Cannot tell" must not become "somebody else's", or every
    // pre-existing claim would vanish from `cairn next` at once.
    const out = rankNext([held(null)], { me: 'claude-code', now: NOW, mySession: 'my-session' })
    expect(out[0]?.tier).toBe('holding')
  })

  it('changes nothing for a caller that cannot name its session', () => {
    const out = rankNext([held('other-session')], { me: 'claude-code', now: NOW })
    expect(out[0]?.tier).toBe('holding')
  })

  it('still surfaces a stale claim from another session as abandoned work', () => {
    // The heartbeat decides, not the claim. Abandoned work is exactly what
    // this is meant to surface.
    const stale = task({
      ref: 'A-1',
      status: 'doing',
      claimedBy: 'claude-code',
      claimedSession: 'other-session',
      heartbeatAt: hoursAgo(48),
      checkpoint: 'got this far',
    })
    const out = rankNext([stale], { me: 'claude-code', now: NOW, mySession: 'my-session' })
    expect(out[0]?.tier).toBe('checkpointed')
  })
})
