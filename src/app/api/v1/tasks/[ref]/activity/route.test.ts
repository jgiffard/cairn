import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), findTask: vi.fn(), recordRunLink: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/tasks', () => ({ findTask: mocks.findTask, refuseArchived: () => null, TASK_LIST_FIELDS: 'id' }))
vi.mock('@/lib/db/client', () => ({ admin: () => ({ from: mocks.from }) }))
vi.mock('@/lib/run-link', () => ({ recordRunLink: mocks.recordRunLink }))
import { GET, POST } from './route'
const params = { params: Promise.resolve({ ref: 'CAIRN-1' }) }
const post = (body: object) => POST(new Request('https://x.test/api/v1/tasks/CAIRN-1/activity', {
  method: 'POST', headers: { authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), params)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticate.mockResolvedValue({ userId: 'u', actorId: 'test', actorType: 'agent', role: 'member', rateKey: Math.random().toString() })
  mocks.findTask.mockResolvedValue({ id: 'task' })
})
it('stores run metadata on evidence and returns it from activity', async () => {
  let stored: Record<string, unknown>
  const query = {
    insert: vi.fn((value) => { stored = { id: 'e1', ...value }; return query }),
    select: vi.fn(() => query), single: vi.fn(async () => ({ data: stored, error: null })),
    eq: vi.fn(() => query), order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: [stored], error: null })),
  }
  mocks.from.mockReturnValue(query)
  const run = { id: 'r1', runner: 'drove', url: 'https://x.test/runs/r1' }
  const response = await post({ event: 'git_commit', sha: 'abcdef1', run })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ data: { data: { run } } })
  const read = await GET(new Request('https://x.test/api/v1/tasks/CAIRN-1/activity'), params)
  expect(await read.json()).toMatchObject({ data: [{ data: { run } }] })
})
it('returns 200 on a retry and 201 for a changed run link', async () => {
  mocks.recordRunLink.mockResolvedValueOnce({ row: { id: 'e1' }, duplicate: true })
    .mockResolvedValueOnce({ row: { id: 'e2' }, duplicate: false })
  expect((await post({ event: 'run_link', run: { id: 'r1', state: 'up' } })).status).toBe(200)
  expect((await post({ event: 'run_link', run: { id: 'r1', state: 'merged' } })).status).toBe(201)
})
it('refuses a run link missing run.id at the route boundary', async () => {
  const response = await post({ event: 'run_link' })
  expect(response.status).toBe(400)
  expect(JSON.stringify(await response.json())).toContain('run.id')
  expect(mocks.recordRunLink).not.toHaveBeenCalled()
})
