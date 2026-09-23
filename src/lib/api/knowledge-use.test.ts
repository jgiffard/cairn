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
      created_at: new Date(Date.UTC(2020, 0, 1)), last_recalled: null }]
    mocks.query.mockResolvedValueOnce({ rows: ranked })

    await expect(unusedKnowledge(30, 1)).resolves.toMatchObject([{ lastRecalled: null }])

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/order by h\.last_recalled asc nulls first, e\.created_at asc, e\.id asc\s+limit \$2/i)
    expect(sql.indexOf('order by h.last_recalled')).toBeGreaterThan(sql.indexOf("knowledge_recall_counts('-infinity'"))
    expect(params[1]).toBe(1)
  })
})
