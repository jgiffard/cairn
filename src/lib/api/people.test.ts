import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
}))

import { resolveAssignee, withAssignees, type Person } from './people'

const cal: Person = { id: '11111111-1111-4111-8111-111111111111', email: 'cal@example.test', name: 'Cal', active: true }
const julien: Person = { id: '22222222-2222-4222-8222-222222222222', email: 'julien@example.test', name: 'Julien', active: true }
const gone: Person = { id: '33333333-3333-4333-8333-333333333333', email: 'gone@example.test', name: 'Gone', active: false }

const rows = (...people: Person[]) => ({ rows: people })

describe('resolveAssignee', () => {
  beforeEach(() => mocks.query.mockReset())

  it('reads me as the human behind the caller', async () => {
    mocks.query.mockResolvedValueOnce(rows(cal))
    await expect(resolveAssignee('me', cal.id)).resolves.toEqual({ ok: true, person: cal })
    expect(mocks.query.mock.calls[0]![1]).toEqual([[cal.id]])
  })

  it('finds someone else by email', async () => {
    mocks.query.mockResolvedValueOnce(rows(julien))
    await expect(resolveAssignee('Julien@Example.test', cal.id)).resolves.toEqual({ ok: true, person: julien })
  })

  it('looks a user id up by id, not by name', async () => {
    mocks.query.mockResolvedValueOnce(rows(julien))
    await resolveAssignee(julien.id, cal.id)
    expect(mocks.query.mock.calls[0]![0]).toContain('u.id = $1::uuid')
  })

  it('refuses a name two people share rather than guessing', async () => {
    mocks.query.mockResolvedValueOnce(rows({ ...cal, name: 'Sam' }, { ...julien, name: 'Sam' }))
    const result = await resolveAssignee('Sam', cal.id)
    expect(result).toMatchObject({ ok: false, code: 'validation_failed' })
  })

  it('prefers the exact email when a display name collides with it', async () => {
    mocks.query.mockResolvedValueOnce(rows(cal, { ...julien, name: cal.email }))
    await expect(resolveAssignee(cal.email, julien.id)).resolves.toEqual({ ok: true, person: cal })
  })

  it('will not give work to a removed user', async () => {
    mocks.query.mockResolvedValueOnce(rows(gone))
    await expect(resolveAssignee(gone.email, cal.id)).resolves.toMatchObject({ ok: false, code: 'validation_failed' })
  })

  it('says who it could not find', async () => {
    mocks.query.mockResolvedValueOnce(rows())
    await expect(resolveAssignee('nobody', cal.id)).resolves.toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('withAssignees', () => {
  beforeEach(() => mocks.query.mockReset())

  it('names every row from one query', async () => {
    mocks.query.mockResolvedValueOnce(rows(cal, julien))
    const named = await withAssignees([
      { ref: 'A-1', assignee_user_id: cal.id },
      { ref: 'A-2', assignee_user_id: julien.id },
      { ref: 'A-3', assignee_user_id: cal.id },
    ])
    expect(named.map((row) => row.assignee?.name)).toEqual(['Cal', 'Julien', 'Cal'])
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0]![1]).toEqual([[cal.id, julien.id]])
  })

  it('does not query for rows that carry no assignee column', async () => {
    const named = await withAssignees([{ ref: 'A-1' }])
    expect(named[0]?.assignee).toBeNull()
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
