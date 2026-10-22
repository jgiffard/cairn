import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), findTask: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/tasks', () => ({ findTask: mocks.findTask, TASK_LIST_FIELDS: 'id' }))
vi.mock('@/lib/db/client', async (original) => ({
  ...await original<typeof import('@/lib/db/client')>(),
  admin: vi.fn(), pool: () => ({ query: mocks.query }),
}))
import { GET } from './route'
import { listTaskRuns } from '@/lib/data'

const get = () => GET(new Request('https://x.test/api/v1/tasks/CAIRN-1/runs'), { params: Promise.resolve({ ref: 'CAIRN-1' }) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticate.mockResolvedValue({ userId: 'u', actorId: 'test', actorType: 'agent', role: 'member', rateKey: Math.random().toString() })
  mocks.findTask.mockResolvedValue({ id: 'task' })
})
it('returns grouped runs from the independent 500 run-row read', async () => {
  const oldRunRows = [
    { event: 'run_link', data: { run: { id: 'r1', state: 'up', seat: 'a' } }, created_at: '2026-01-01T00:00:00Z' },
    { event: 'git_commit', data: { run: { id: 'r1', seats: ['b'] }, sha: 'abcdef1', url: 'https://x/pull/1' }, created_at: '2026-01-02T00:00:00Z' },
    { event: 'git_push', data: { run: { id: 'r1' }, sha: 'abcdef1' }, created_at: '2026-01-03T00:00:00Z' },
    { event: 'run_result', data: { run: { id: 'r1' }, command: 'npm test', status: 'passed' }, created_at: '2026-01-04T00:00:00Z' },
    { event: 'run_link', data: { run: { id: 'r1', state: 'merged' } }, created_at: '2026-01-05T00:00:00Z' },
    { event: 'run_link', data: { run: { id: 'r2' } }, created_at: '2026-01-06T00:00:00Z' },
  ]
  // Simulate SQL filtering before LIMIT, with >100 newer untagged rows.
  const all = [...oldRunRows, ...Array.from({ length: 150 }, () => ({ event: 'status_changed', data: {}, created_at: '2026-02-01T00:00:00Z' }))]
  mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
    expect(sql).toContain("data->'run'->>'id' is not null")
    expect(sql).toContain('limit 500')
    expect(args).toEqual(['task'])
    return { rows: all.filter((r) => 'run' in r.data).map((r) => ({ ...r, created_at: new Date(r.created_at) })) }
  })
  const response = await get()
  expect(response.status).toBe(200)
  const { data } = await response.json()
  expect(data).toHaveLength(2)
  expect(data.map((r: { id: string }) => r.id)).toEqual(['r2', 'r1'])
  expect(data[1]).toMatchObject({ state: 'merged', seats: ['a', 'b'], prs: ['https://x/pull/1'], checks: [{ command: 'npm test', status: 'passed' }] })
  expect(data[1].commits).toHaveLength(1)
  expect(await listTaskRuns('task')).toEqual(data)
})
it('returns not_found for an unknown or invisible task', async () => {
  mocks.findTask.mockResolvedValue(null)
  const response = await get()
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ code: 'not_found' })
  expect(mocks.query).not.toHaveBeenCalled()
})
