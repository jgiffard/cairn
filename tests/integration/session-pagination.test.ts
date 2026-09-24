import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { expect, it } from 'vitest'
import { listSessions, sessionCursor } from '../../src/lib/api/sessions'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

it('paginates live and ended sessions without losing ties or microseconds', async () => {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  const owner = randomUUID()
  const cwd = `/pagination-test/${owner}`
  try {
    await client.query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)',
      [owner, `pagination-${owner}@example.test`, 'not-used'])
    // More completed rows than the web page size; equal timestamps also cross
    // a page boundary, including a timestamp with sub-millisecond precision.
    for (let i = 0; i < 45; i += 1) {
      await client.query(
        `insert into sessions (owner_user_id, external_id, platform_source, cwd, ended_at)
         values ($1,$2,'other',$3,$4::timestamptz)`,
        [owner, `pagination:${owner}:${i}`, cwd,
          i < 42 ? '2026-09-23T12:00:00.123456Z' : '2026-09-22T12:00:00.654321Z'],
      )
    }
    for (let i = 0; i < 3; i += 1) {
      await client.query(
        `insert into sessions (owner_user_id, external_id, platform_source, cwd, ended_at)
         values ($1,$2,'other',$3,null)`,
        [owner, `pagination:${owner}:live:${i}`, cwd],
      )
    }

    const first = await listSessions(owner, { cwd, limit: 40 })
    expect(first).toHaveLength(40)
    expect(first.filter((row) => row.ended_at === null)).toHaveLength(3)
    const second = await listSessions(owner, { cwd, limit: 40, before: sessionCursor(first.at(-1)!) })
    expect(second).toHaveLength(8)
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(48)

    const seen: string[] = []
    let before: string | undefined
    for (let page = 0; page < 60; page += 1) {
      const rows = await listSessions(owner, { cwd, before, limit: 2 })
      if (rows.length === 0) break
      seen.push(...rows.map((row) => row.id))
      if (page === 0) expect(rows.every((row) => row.ended_at === null)).toBe(true)
      before = sessionCursor(rows.at(-1)!)
    }
    expect(seen).toHaveLength(48)
    expect(new Set(seen).size).toBe(48)
    expect((await listSessions(owner, { cwd, before, limit: 2 }))).toEqual([])
  } finally {
    await client.query('delete from sessions where cwd = $1', [cwd])
    await client.query('delete from app_users where id = $1', [owner])
    await client.end()
  }
})
