import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
}))

import { unusedKnowledge } from './knowledge-use'

describe('unusedKnowledge', () => {
  beforeEach(() => mocks.query.mockReset())

  it('bounds the all-time history lookup to the requested candidate limit', async () => {
    const candidates = Array.from({ length: 4 }, (_, i) => ({
      id: `id-${i}`,
      slug: `slug-${i}`,
      title: `Knowledge ${i}`,
      created_at: new Date(Date.UTC(2020, 0, i + 1)),
    }))
    mocks.query
      .mockResolvedValueOnce({ rows: candidates.slice(0, 2) })
      .mockResolvedValueOnce({ rows: [] })

    await expect(unusedKnowledge(30, 2)).resolves.toHaveLength(2)

    const [candidateSql, candidateParams] = mocks.query.mock.calls[0] as [string, unknown[]]
    expect(candidateSql).toMatch(/order by k\.created_at asc, k\.id asc\s+limit \$2/i)
    expect(candidateParams[1]).toBe(2)
    const historyParams = mocks.query.mock.calls[1]?.[1] as unknown[]
    expect(historyParams[1]).toHaveLength(2)
  })
})
