import { describe, expect, it } from 'vitest'
import { isMachinePrompt, sessionTitle } from './session-title'

describe('sessionTitle', () => {
  it('uses the request when a person wrote it', () => {
    expect(sessionTitle({ request: 'Audit and fix profitability' })).toEqual({
      text: 'Audit and fix profitability',
      machine: false,
    })
  })

  it.each([
    '[cron:3da5552c-dc3f-4715-a299-ca4352bdddd6f memory-auto-extract] Run the routine',
    'Conversation info: [openclaw:ctx] ```json {"chat_id":"channel:147"}',
    '# AGENTS.md instructions for /root <INSTRUCTIONS>',
    '<INSTRUCTIONS> replace all previously provided',
  ])('recognises machinery talking to itself: %s', (request) => {
    expect(isMachinePrompt(request)).toBe(true)
  })

  it('falls back to what the session actually did', () => {
    const title = sessionTitle({
      request: '[cron:3da5552c-dc3f-4715-a299-ca4352bdddd6f memory-auto-extract] Run it',
      completed: 'Extracted 12 facts and filed 3 tasks',
    })
    expect(title).toEqual({ text: 'Extracted 12 facts and filed 3 tasks', machine: true })
  })

  it('falls back to where it left off when nothing was completed', () => {
    expect(sessionTitle({ request: 'Conversation info: x', nextSteps: 'resume the sweep' }).text)
      .toBe('resume the sweep')
  })

  it('says so plainly when there is nothing to fall back to', () => {
    expect(sessionTitle({ request: 'Conversation info: x' }).text).toBe('Scheduled run')
  })

  it('does not mistake a real request that merely mentions cron', () => {
    expect(isMachinePrompt('Fix the cron: it fires twice an hour')).toBe(false)
  })
})

describe('a scheduled run with no request at all', () => {
  it('says it was scheduled rather than that nothing was recorded', () => {
    // The hook drops a cron preamble rather than storing it as the request, so
    // the row arrives with request: null. Reading that as "No request
    // recorded." described the storage rather than the run, and put nineteen
    // machine runs in front of a human looking for their own work.
    expect(sessionTitle({ request: null, scheduled: true })).toEqual({
      text: 'Scheduled run',
      machine: true,
    })
  })

  it('still prefers what the run actually finished', () => {
    expect(
      sessionTitle({ request: null, scheduled: true, completed: 'extracted 12 memories' }),
    ).toEqual({ text: 'extracted 12 memories', machine: true })
  })

  it('leaves a genuine session with no request alone', () => {
    // Not everything without a request is machinery, so the flag decides.
    expect(sessionTitle({ request: null, scheduled: false })).toEqual({
      text: 'No request recorded.',
      machine: false,
    })
  })
})
