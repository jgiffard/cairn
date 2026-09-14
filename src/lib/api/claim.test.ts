import { describe, expect, it } from 'vitest'
import { shouldClaimByWorking } from './claim'

/**
 * Writing to a task's work log is working on it.
 *
 * 36% of recently closed tasks across CAIRN, OD and QRY were never claimed, so
 * they never showed as In Progress while somebody was on them. The cause is
 * structural: nothing cost anything when it was skipped, so an agent could
 * note, checkpoint and close an unclaimed task and never perceive a
 * difference. The fix is to make the ordinary path produce the right state.
 *
 * The limits matter more than the rule, because each one is a way this could
 * do harm instead.
 */
const agent = { actorType: 'agent' }
const human = { actorType: 'human' }

describe('when working on a task should claim it', () => {
  it('claims an open task nobody holds', () => {
    expect(shouldClaimByWorking(agent, { status: 'backlog' })).toBe(true)
    expect(shouldClaimByWorking(agent, { status: 'todo' })).toBe(true)
    // Started and dropped: taking it back is the point.
    expect(shouldClaimByWorking(agent, { status: 'doing', claimed_by: null })).toBe(true)
  })

  it('never steals from a live holder', () => {
    // Noting on a colleague's task has to stay a note. The lease is stolen
    // only through an explicit claim, where the caller sees the 409.
    expect(shouldClaimByWorking(agent, { status: 'doing', claimed_by: 'openclaw' })).toBe(false)
  })

  it('never reopens finished work', () => {
    // A note on a closed task is a postscript, not a restart.
    expect(shouldClaimByWorking(agent, { status: 'done' })).toBe(false)
    expect(shouldClaimByWorking(agent, { status: 'cancelled' })).toBe(false)
  })

  it('leaves humans alone', () => {
    // People coordinate by talking. Someone leaving a comment has not
    // necessarily picked the work up, and showing them as holding it would be
    // a claim about them they did not make.
    expect(shouldClaimByWorking(human, { status: 'todo' })).toBe(false)
  })
})
