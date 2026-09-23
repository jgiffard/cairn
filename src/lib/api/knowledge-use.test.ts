import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
}))

import { unusedKnowledge } from './knowledge-use'

describe('unusedKnowledge', () => {
  beforeEach(() => mocks.query.mockReset())

  it('ranks never-recalled entries before applying the result limit', async () => {
    const ranked = [{ slug: 'never-recalled', title: 'Never recalled',
      created_at: new Date(Date.UTC(2020, 0, 1)), last_recalled_at: null }]
    mocks.query.mockResolvedValueOnce({ rows: ranked })

    await expect(unusedKnowledge(30, 1)).resolves.toMatchObject([{ lastRecalled: null }])

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/order by k\.last_recalled_at asc nulls first, k\.created_at asc, k\.id asc\s+limit \$2/i)
    expect(params[1]).toBe(1)
  })

  it('never recounts all-time history per request', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    await unusedKnowledge(30, 1)
    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]]
    // 062 keeps last_recalled_at on the row; an unbounded aggregate over
    // search_events/knowledge_reads is exactly what it replaced.
    expect(sql).not.toMatch(/knowledge_recall_counts|search_events|knowledge_reads|-infinity/i)
  })
})
