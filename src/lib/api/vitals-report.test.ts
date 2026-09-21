import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The memory telemetry reaches something without a browser.
 *
 * `readMemoryUseFor` had exactly one call site — src/app/(app)/vitals/page.tsx
 * — so searches, widened searches, zero-result searches and work filed without
 * checking were answerable only by a person who opened the Vitals page. Every
 * writer of knowledge in this system is an agent, and an agent reads
 * `cairn vitals` and GET /api/v1/vitals. Neither carried a byte of it.
 *
 * That is the failure knowledge/gaps/route.ts names in its own header, one
 * panel over: "the findings were visible only to a person who happened to
 * click Map". See CAIRN-254.
 */

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({ rpc: mocks.rpc }),
}))

import { readVitals } from './vitals'
import type { Actor } from './auth'

const actor = { userId: 'user-1' } as Actor

const vitalsPayload = {
  windowHours: 24,
  sessions: { recent: 6, recentWithFiles: 5, recentSummarised: 6, baseline: 40, baselineWithFiles: 35 },
  tasks: { opened: 4, closed: 5, stalled: 1, held: 2, closedWithoutTrace: 0 },
  autoReleased: 0,
  knowledgeWritten: 2,
  agents: [],
}

const memoryPayload = {
  windowHours: 24,
  searches: 12,
  widened: 3,
  zeroResults: 2,
  byAgent: [{ agent: 'claude-code · Cal', searches: 12 }],
  tasksFiled: 5,
  tasksFiledWithoutChecking: 4,
  recentMisses: ['vitals closure predicate'],
}

const answerBoth = () => {
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'cairn_memory_use'
      ? { data: memoryPayload, error: null }
      : { data: vitalsPayload, error: null },
  )
}

describe('the vitals an agent is given', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('carries whether the memory was consulted, not only whether it was written', async () => {
    answerBoth()
    const report = await readVitals(actor, 24)

    expect(mocks.rpc.mock.calls.map((c) => c[0]).sort()).toEqual([
      'cairn_memory_use',
      'cairn_vitals',
    ])
    expect(report.memory).toEqual(memoryPayload)
    // and the counts it already carried are untouched
    expect(report.knowledgeWritten).toBe(2)
    expect(report.tasks.closed).toBe(5)
  })

  it('asks both questions about the same window', async () => {
    // A memory block from a different window beside these counts would be a
    // worse answer than none: it invites a comparison that is not valid.
    answerBoth()
    await readVitals(actor, 72)

    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    for (const [, params] of mocks.rpc.mock.calls) {
      expect(params).toMatchObject({ p_owner: 'user-1', p_hours: 72 })
    }
  })

  it('still reports the vital signs when the memory aggregate cannot be read', async () => {
    // This endpoint is the monitor. One of its two questions going unanswerable
    // must not stop it answering the other — that is the failure mode the whole
    // panel exists to catch.
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'cairn_memory_use'
        ? { data: null, error: { message: 'function cairn_memory_use does not exist' } }
        : { data: vitalsPayload, error: null },
    )

    const report = await readVitals(actor, 24)
    expect(report.memory).toBeNull()
    expect(report.sessions.recent).toBe(6)
  })

  it('fails loudly when the vital signs themselves cannot be read', async () => {
    // The tolerance above is for the block that was added, not for the one the
    // endpoint has always been about.
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'cairn_vitals'
        ? { data: null, error: { message: 'boom' } }
        : { data: memoryPayload, error: null },
    )

    await expect(readVitals(actor, 24)).rejects.toThrow('boom')
  })
})

describe('GET /api/v1/vitals', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/api/v1/vitals/route.ts'),
    'utf8',
  )

  it('returns the whole report rather than a hand-picked subset of it', () => {
    // The route spreading the report is what makes the memory block reach the
    // CLI. Rebuilding the response field by field is how it stopped reaching
    // it the first time.
    expect(source).toContain('readVitals')
    expect(source).toMatch(/ok\(\{\s*\.\.\.report/)
  })
})
