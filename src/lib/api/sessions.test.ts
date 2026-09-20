import { describe, expect, it } from 'vitest'
import { heldByThisSession, splitHeldByWorked, untouchedCheckpoint, workedCheckpoint } from './sessions'

/**
 * Session end checkpoints every task the agent still holds. It used to write
 * the same summary to all of them, so a task claimed days earlier and never
 * opened was handed a progress report about different work — BB-359, about
 * login failures, carried a summary of a UI refactor.
 *
 * That failure is silent: a wrong checkpoint reads exactly like a right one,
 * and `cairn context` hands it to the next agent as fact. Hence tests.
 */
describe('checkpointing held tasks', () => {
  const held = [
    { id: '1', number: 359, project: { key: 'BB' } },
    { id: '2', number: 37, project: { key: 'AC' } },
    { id: '3', number: 12, project: { key: 'HM' } },
  ]
  const refOf = (t: (typeof held)[number]) => `${t.project.key}-${t.number}`

  it('separates the tasks the session worked from the ones it only held', () => {
    const { touched, untouched } = splitHeldByWorked(held, ['AC-37'], refOf)

    expect(touched.map(refOf)).toEqual(['AC-37'])
    expect(untouched.map(refOf)).toEqual(['BB-359', 'HM-12'])
  })

  it('treats a session that recorded no task refs as having worked none of them', () => {
    const { touched, untouched } = splitHeldByWorked(held, [], refOf)

    expect(touched).toEqual([])
    expect(untouched).toHaveLength(3)
  })

  // A ref the session touched but does not hold must not drag anything in.
  it('ignores worked refs that are not held', () => {
    const { touched } = splitHeldByWorked(held, ['ZZ-99'], refOf)

    expect(touched).toEqual([])
  })

  it('never gives an untouched task the summary of the work done elsewhere', () => {
    const summary = 'Rewrote the design system and shipped the mobile shell.'

    expect(untouchedCheckpoint(['AC-37'])).not.toContain(summary)
    expect(untouchedCheckpoint(['AC-37'])).toContain('Still held, not progressed')
    // Naming where the attention went is what lets a reader judge the claim.
    expect(untouchedCheckpoint(['AC-37'])).toContain('AC-37')
  })

  it('still says something true when the session names no refs at all', () => {
    expect(untouchedCheckpoint([])).toContain('worked elsewhere')
    expect(untouchedCheckpoint([])).not.toContain('on .')
  })

  it('caps the refs it lists rather than pasting an entire sweep', () => {
    const many = Array.from({ length: 30 }, (_, i) => `BB-${i}`)
    const text = untouchedCheckpoint(many)

    expect(text).toContain('BB-0')
    expect(text).not.toContain('BB-29')
  })

  it('marks both kinds as automatic, so neither reads as something a human wrote', () => {
    expect(workedCheckpoint('did the thing')).toContain('Recorded automatically')
    expect(untouchedCheckpoint(['AC-37'])).toContain('Recorded automatically')
  })
})

/**
 * A checkpoint belongs to the session that did the work.
 *
 * This used to select on `claimed_by` alone, which is an actorLabel shared by
 * every Claude Code session on the machine. Three knowledge-map tasks ended up
 * carrying a progress report about merging an unrelated pull request, because
 * the identity matched and nothing else was consulted. CAIRN-182 fixed the
 * version of this that stamped tasks the session never touched; this is the
 * same wrong summary arriving through identity rather than through the file
 * list.
 */
describe('heldByThisSession', () => {
  const held = [
    { ref: 'CAIRN-209', claimed_session: 'other-session' },
    { ref: 'CAIRN-231', claimed_session: 'this-session' },
    { ref: 'CAIRN-100', claimed_session: null },
  ]

  it('leaves another session\u2019s held tasks alone', () => {
    expect(heldByThisSession(held, 'this-session').map((t) => t.ref)).toEqual([
      'CAIRN-231',
      'CAIRN-100',
    ])
  })

  it('keeps a claim that names no session', () => {
    // Claimed before the column existed, or by a runtime that cannot name
    // itself. Excluding it would quietly stop checkpointing work genuinely
    // held — a silent regression traded for a silent bug.
    expect(heldByThisSession(held, 'this-session').some((t) => t.ref === 'CAIRN-100')).toBe(true)
  })

  it('changes nothing for a caller that cannot name its session', () => {
    expect(heldByThisSession(held, null)).toHaveLength(3)
  })
})
