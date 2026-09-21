import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  searchAll: vi.fn(),
  searchTasks: vi.fn(),
  recordSearch: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/search', () => ({
  searchAll: mocks.searchAll,
  searchTasks: mocks.searchTasks,
}))

vi.mock('@/lib/api/search-events', () => ({
  recordSearch: mocks.recordSearch,
  recordKnowledgeRead: vi.fn(),
}))

vi.mock('@/lib/api/staleness', () => ({ stalenessFor: vi.fn(async () => new Map()) }))

// markStaleKnowledge reaches the knowledge table directly; it is not what is
// under test here, so it returns nothing and the results stay unmarked.
vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }),
  }),
}))

import { GET } from './route'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  rateKey: `search-refs-${Math.random()}`,
  sessionId: null,
}

const search = (query: string) =>
  GET(
    new Request(`https://cairn.example.test/api/v1/search?${query}`),
    { params: Promise.resolve({}) },
  )

/** The sixth argument to recordSearch: the refs that came back. */
const recordedRefs = () => mocks.recordSearch.mock.calls[0]?.[5] as string[]

const unifiedRow = (kind: string, ref: string) => ({
  kind,
  id: `id-${ref}`,
  ref,
  title: ref,
  subtitle: null,
  project_key: 'CAIRN',
  status: null,
  type: null,
  answered: false,
  updated_at: '2026-09-21T00:00:00.000Z',
  body_bytes: 40,
  rank: 1,
  widened: false,
})

const taskRow = (number: number) => ({
  id: `id-${number}`,
  number,
  title: `task ${number}`,
  type: 'bug',
  status: 'open',
  priority: 'medium',
  resolution: null,
  resolution_kind: null,
  description: null,
  claimed_by: null,
  updated_at: '2026-09-21T00:00:00.000Z',
  external_ref: 'LEGACY-373',
  project_key: 'CAIRN',
  rank: 1,
  coverage: 1,
  widened: false,
})

describe('search records which entries it returned', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.searchAll.mockReset()
    mocks.searchTasks.mockReset()
    mocks.recordSearch.mockReset().mockResolvedValue(undefined)
  })

  it('stores the refs of a unified search, in rank order', async () => {
    mocks.searchAll.mockResolvedValue({
      rows: [
        unifiedRow('knowledge', 'supabase-connection-pooling'),
        unifiedRow('task', 'CAIRN-131'),
        unifiedRow('note', 'CAIRN-88#3'),
      ],
      widened: true,
    })

    const response = await search('q=supavisor+pool+timeouts')

    expect(response.status).toBe(200)
    expect(recordedRefs()).toEqual([
      'supabase-connection-pooling',
      'CAIRN-131',
      'CAIRN-88#3',
    ])
  })

  it('stores the refs on the task-only path too', async () => {
    mocks.searchTasks.mockResolvedValue({ rows: [taskRow(131), taskRow(88)], widened: false })

    await search('q=pool+timeouts&tasksOnly=true')

    // The Cairn ref, never the imported identifier — a stored "LEGACY-373"
    // looks like a ref and resolves to nothing, so the event could not be
    // replayed against the corpus.
    expect(recordedRefs()).toEqual(['CAIRN-131', 'CAIRN-88'])
  })

  it('stores an empty list rather than nothing when the search found nothing', async () => {
    mocks.searchAll.mockResolvedValue({ rows: [], widened: true })

    await search('q=a+subject+cairn+has+never+heard+of')

    expect(recordedRefs()).toEqual([])
  })

  it('records the same count it reports to the caller', async () => {
    mocks.searchAll.mockResolvedValue({
      rows: [unifiedRow('task', 'CAIRN-1'), unifiedRow('task', 'CAIRN-2')],
      widened: false,
    })

    const response = await search('q=anything')
    const payload = (await response.json()) as { data: { count: number; results: unknown[] } }

    expect(payload.data.count).toBe(2)
    expect(recordedRefs()).toHaveLength(payload.data.results.length)
  })
})
