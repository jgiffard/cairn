import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/api/auth'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), rpc: vi.fn(), query: vi.fn(), findTask: vi.fn(), withAssignee: vi.fn(),
}))
vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/db/client', () => ({
  admin: () => ({ rpc: mocks.rpc }), pool: () => ({ query: mocks.query }),
}))
vi.mock('@/lib/api/tasks', async (original) => ({
  ...await original<typeof import('@/lib/api/tasks')>(), findTask: mocks.findTask,
}))
vi.mock('@/lib/api/people', () => ({ withAssignee: mocks.withAssignee }))
import { POST } from './route'

const holder = 'codex · Cal'
const caller: Actor = {
  userId: 'user', actorType: 'agent', actorId: holder, userDisplayName: 'Cal',
  role: 'member', rateKey: 'claim-tests', sessionId: 'session-a',
}
const held = {
  id: 'task', number: 1, project_id: 'project', project: { key: 'TEST', status: 'active' },
  title: 'Held task', claimed_by: holder, claimed_session: 'session-a', status: 'doing',
  attempt: 1, ownership_version: 1, heartbeat_at: '2026-10-22T00:00:00.000Z',
}
const post = (body: object = {}, session: string | null = 'session-a') => POST(new Request(
  'https://cairn.example.test/api/v1/tasks/TEST-1/claim', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test', 'Content-Type': 'application/json',
      ...(session ? { 'X-Cairn-Session': session } : {}),
    },
    body: JSON.stringify(body),
  },
), { params: Promise.resolve({ ref: 'TEST-1' }) })

describe('claim route same-session renewals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticate.mockResolvedValue({ ...caller, rateKey: `claim-${Math.random()}` })
    mocks.findTask.mockResolvedValue({ ...held })
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    mocks.query.mockResolvedValue({ rows: [{ row: { ...held, heartbeat_at: '2026-10-22T00:01:00.000Z' } }] })
    mocks.withAssignee.mockImplementation(async (row) => ({ ...row, assignee: null }))
  })

  it('returns 200 with renewed heartbeat and marker for the same agent session', async () => {
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: {
      ...held, heartbeat_at: '2026-10-22T00:01:00.000Z', renewed: true, assignee: null,
    } })
    expect(mocks.query).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls[0]![1].slice(0, 3)).toEqual(['task', holder, 'session-a'])
  })

  it('returns the original attempt and ownership generation on concurrent retries', async () => {
    const responses = await Promise.all([post(), post()])
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: {
        renewed: true, attempt: held.attempt, ownership_version: held.ownership_version, claimed_by: holder,
      } })
    }
  })

  it('returns 409 already_claimed naming the holder for a different session', async () => {
    mocks.authenticate.mockResolvedValue({ ...caller, sessionId: 'session-b' })
    const response = await post({}, 'session-b')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_claimed', claimedBy: holder })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('returns the existing held refusal for a caller with no session', async () => {
    mocks.authenticate.mockResolvedValue({ ...caller, sessionId: null })
    const response = await post({}, null)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_claimed', claimedBy: holder })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('refuses a legacy claim whose stored session is null', async () => {
    mocks.findTask.mockResolvedValue({ ...held, claimed_session: null })
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_claimed', claimedBy: holder })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it.each(['done', 'cancelled'])('keeps the existing refusal for terminal status %s', async (status) => {
    mocks.findTask.mockResolvedValue({ ...held, status })
    const response = await post()
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('keeps the existing refusal for an open hand-off', async () => {
    mocks.findTask.mockResolvedValue({
      ...held, handoff_ref: 'EXT-1', handoff_tracker: 'linear', handoff_status: 'doing',
    })
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'handed_off' })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it.each([
    { actorType: 'human' as const },
    { actorId: 'codex · Someone else', userId: 'other-user', userDisplayName: 'Someone else' },
  ])('refuses a matching session without the holder agent identity %j', async (identity) => {
    mocks.authenticate.mockResolvedValue({ ...caller, ...identity })
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_claimed', claimedBy: holder })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('returns 409 with the current holder when conditional renewal loses ownership', async () => {
    mocks.query.mockResolvedValue({ rows: [] })
    mocks.findTask.mockResolvedValueOnce(held).mockResolvedValueOnce({ ...held, claimed_by: 'new holder' })
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_claimed', claimedBy: 'new holder' })
  })

  it('reports a database error without returning a renewed row', async () => {
    mocks.query.mockRejectedValue(new Error('audit insert failed'))
    const response = await post()
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'internal_error', error: 'audit insert failed' })
    expect(mocks.withAssignee).not.toHaveBeenCalled()
  })
})
