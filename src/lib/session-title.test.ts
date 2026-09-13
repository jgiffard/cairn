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
