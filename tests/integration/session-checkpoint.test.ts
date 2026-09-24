import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { expect, it } from 'vitest'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

it('keeps one live session and refuses to reopen it after closure', async () => {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query('begin')
  try {
    const owner = randomUUID()
    const externalId = `integration:${randomUUID()}`
    await client.query(
      'insert into app_users (id, email, encrypted_password) values ($1,$2,$3)',
      [owner, `session-${owner}@example.test`, 'not-used'],
    )
    const upsert = async (
      endedAt: Date | null, request: string | null, completed: string | null,
      files: string[] = [], taskRefs: string[] = [],
    ) => client.query<{
      id: string; ended_at: Date | null; request: string | null; completed: string | null
      files: string[]; task_refs: string[]
    }>(
      `insert into sessions (owner_user_id, external_id, platform_source, ended_at,
                             request, completed, files, task_refs)
       values ($1,$2,'other',$3,$4,$5,$6::jsonb,$7)
       on conflict (platform_source, external_id) do update
         set ended_at = excluded.ended_at, request = excluded.request,
             completed = excluded.completed, files = excluded.files, task_refs = excluded.task_refs
       returning id, ended_at, request, completed, files, task_refs`,
      [owner, externalId, endedAt, request, completed, JSON.stringify(files), taskRefs],
    )

    const first = await upsert(null, 'Work started', 'Initial progress', ['src/example.ts'], ['DEMO-1'])
    const firstRow = first.rows.at(0)
    if (!firstRow) throw new Error('Session insert did not return a row')
    const updated = await upsert(null, null, 'More progress')
    expect(updated.rows.at(0)?.id).toBe(firstRow.id)
    expect(updated.rows.at(0)?.ended_at).toBeNull()
    expect(updated.rows.at(0)?.request).toBe('Work started')
    expect(updated.rows.at(0)?.files).toEqual(['src/example.ts'])
    expect(updated.rows.at(0)?.task_refs).toEqual(['DEMO-1'])

    const ended = await upsert(new Date(), null, null)
    expect(ended.rows.at(0)?.id).toBe(firstRow.id)
    expect(ended.rows.at(0)?.ended_at).not.toBeNull()
    expect(ended.rows.at(0)?.request).toBe('Work started')
    expect(ended.rows.at(0)?.completed).toBe('More progress')

    await client.query('savepoint late_checkpoint')
    await expect(upsert(null, 'Stale checkpoint', null)).rejects.toMatchObject({ code: 'PZ001' })
    await client.query('rollback to savepoint late_checkpoint')
    const replay = await upsert(new Date(), null, null)
    expect(replay.rows.at(0)?.id).toBe(firstRow.id)
    expect(replay.rows.at(0)?.completed).toBe('More progress')
    expect((await client.query('select ended_at from sessions where id=$1', [firstRow.id])).rows.at(0)?.ended_at).not.toBeNull()
  } finally {
    await client.query('rollback')
    await client.end()
  }
})
