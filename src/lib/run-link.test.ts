import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }))
vi.mock('@/lib/db/client', () => ({
  pool: () => ({ connect: mocks.connect }),
  normalizeDatabaseValue: (value: unknown) => value,
}))
import { recordRunLink } from './run-link'
const actor = { userId: 'u', actorType: 'agent', actorId: 'test' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
})
it('returns the latest identical link without inserting and records changed state', async () => {
  let latest: object | undefined
  let inserts = 0
  mocks.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('select id')) return { rows: latest ? [latest] : [] }
    if (sql.startsWith('insert')) {
      inserts++
      latest = { id: String(inserts), data: JSON.parse(args[4] as string) }
      return { rows: [latest] }
    }
    return { rows: [] }
  })
  const data = { run: { id: 'r1', runner: 'drove', state: 'up', seats: ['a'], url: 'https://x/r1' } }
  const first = await recordRunLink('task', actor, data)
  const retry = await recordRunLink('task', actor, data)
  expect(first.duplicate).toBe(false)
  expect(retry).toEqual({ ...first, duplicate: true })
  expect(inserts).toBe(1)
  expect((await recordRunLink('task', actor, { run: { ...data.run, state: 'merged' } })).duplicate).toBe(false)
  expect(inserts).toBe(2)
  expect(mocks.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(3)
  expect(mocks.release).toHaveBeenCalledTimes(3)
})
it('rolls back and releases the transaction on database failure', async () => {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('select id')) throw new Error('db error')
    return { rows: [] }
  })
  await expect(recordRunLink('task', actor, { run: { id: 'r1' } })).rejects.toThrow('db error')
  expect(mocks.query).toHaveBeenCalledWith('rollback')
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('serializes concurrent identical retries with a transaction lock', async () => {
  let tail = Promise.resolve()
  let latest: object | undefined
  let inserts = 0
  mocks.connect.mockImplementation(async () => {
    let unlock = () => {}
    return {
      release: vi.fn(),
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          expect(args).toEqual([JSON.stringify(['task', 'r1'])])
          const prior = tail
          tail = new Promise<void>((resolve) => { unlock = resolve })
          await prior
        }
        if (sql.startsWith('select id')) return { rows: latest ? [latest] : [] }
        if (sql.startsWith('insert')) {
          expect(sql).toContain('clock_timestamp()')
          inserts++
          latest = { id: String(inserts), data: JSON.parse(args[4] as string) }
          return { rows: [latest] }
        }
        if (sql === 'commit' || sql === 'rollback') unlock()
        return { rows: [] }
      },
    }
  })
  const results = await Promise.all(Array.from({ length: 5 }, () => recordRunLink('task', actor, { run: { id: 'r1', state: 'up' } })))
  expect(inserts).toBe(1)
  expect(results.filter((r) => r.duplicate)).toHaveLength(4)
  expect(results.every((r) => (r.row as { id: string }).id === '1')).toBe(true)
})
