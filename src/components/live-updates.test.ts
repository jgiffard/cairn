import { describe, expect, it } from 'vitest'
import { onStreamError } from './live-updates'

/**
 * The badge read "Not live" on open pages after every deploy, and stayed that
 * way until someone reloaded.
 *
 * EventSource only retries a connection that DROPS. A response it considers
 * fatal — anything that is not 200 `text/event-stream`, such as the 502 served
 * while a deploy swaps the container, or a 401 once a session expires — sets
 * `readyState = CLOSED` and it never tries again. Nothing restarted it, so the
 * page went on rendering and silently stopped updating.
 *
 * That is invisible from the outside, which is why the decision is tested
 * rather than trusted.
 */
describe('reacting to a stream error', () => {
  it('restarts the stream itself when the browser has given up', () => {
    const next = onStreamError(true, 0)

    expect(next.state).toBe('offline')
    // The point of the fix: something must actually be scheduled.
    expect(next.retryInMs).toBeGreaterThan(0)
  })

  it('leaves a mid-stream drop to EventSource, which already retries it', () => {
    const next = onStreamError(false, 0)

    expect(next.state).toBe('reconnecting')
    expect(next.retryInMs).toBeUndefined()
  })

  it('backs off as attempts repeat, rather than hammering a server that is still down', () => {
    const waits = [0, 1, 2, 3].map((attempt) => onStreamError(true, attempt).retryInMs)

    expect(waits).toEqual([...waits].sort((a, b) => (a ?? 0) - (b ?? 0)))
    expect(new Set(waits).size).toBeGreaterThan(1)
  })

  it('caps the backoff, so a long outage still recovers promptly when it ends', () => {
    const late = onStreamError(true, 99).retryInMs

    expect(late).toBeDefined()
    expect(late).toBeLessThanOrEqual(30_000)
  })

  // A deploy is ~4 minutes. The first retry has to be quick enough that a page
  // left open recovers on its own rather than waiting for a human to reload.
  it('retries quickly on the first failure', () => {
    expect(onStreamError(true, 0).retryInMs).toBeLessThanOrEqual(2_000)
  })

  it('never reports a dead stream as merely reconnecting', () => {
    // `reconnecting` is the reassuring state — the server closes the stream
    // every ten minutes by design. Using it for a dead connection would hide
    // exactly the failure this indicator exists to surface.
    expect(onStreamError(true, 5).state).not.toBe('reconnecting')
  })
})
