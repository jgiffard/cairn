import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 084 (CAIRN-408): every board gets a completed `promoted` stage, and Croft's
 * delivery stages leave the boards where no live subject is in them. Archived
 * subjects in a retired stage move to `promoted`; a stage that still holds a
 * live subject is kept and named in a NOTICE.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const MIGRATION = '084_lab_promoted_stage.sql'
const clients: Client[] = []

const freshDatabase = async () => {
  const name = `cairn_pr_${randomUUID().replaceAll('-', '')}`
  const root = new Client({ connectionString: databaseUrl })
  await root.connect()
  await root.query(`create database "${name}"`)
  await root.end()
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  clients.push(client)
  return client
}

const files = async () => (await readdir(join(process.cwd(), 'migrations'))).filter((f) => f.endsWith('.sql')).sort()

const apply = async (client: Client, names: string[]) => {
  for (const file of names) await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
}

/** An instance migrated up to, not including, 084: under construction and Croft's nine stages. */
const before084 = async () => {
  const client = await freshDatabase()
  const all = await files()
  await apply(client, all.filter((f) => f < '084_'))
  return { client, rest: all.filter((f) => f >= '084_') }
}

const board = async (client: Client) =>
  (await client.query('select name, category, position from lab_stages order by position, name')).rows.map(
    (r) => `${r.position}:${r.name}:${r.category}`,
  )

const stageId = async (client: Client, name: string) =>
  (await client.query<{ id: string }>('select id from lab_stages where name = $1', [name])).rows[0]?.id

const file = async (client: Client, title: string, stage: string, extra: { archived?: boolean; conclusion?: string } = {}) =>
  (
    await client.query<{ id: string }>(
      `insert into subjects (title, stage_id, actor_type, actor_id, conclusion, archived_at)
       values ($1, $2, 'agent', 'a', $3, $4) returning id`,
      [title, await stageId(client, stage), extra.conclusion ?? null, extra.archived ? '2026-09-01T10:00:00Z' : null],
    )
  ).rows[0]!.id

const notices = (client: Client) => {
  const seen: string[] = []
  client.on('notice', (n) => seen.push(n.message ?? ''))
  return seen
}

afterAll(async () => {
  for (const client of clients) await client.end()
})

describe('migration 084: promoted, and the delivery stages retire', () => {
  it('leaves a new instance with under construction, to explore, exploring, done, rejected, promoted', async () => {
    const { client, rest } = await before084()
    await apply(client, rest)
    expect(await board(client)).toEqual([
      '0:under construction:planned',
      '1:to explore:planned',
      '2:exploring:active',
      '3:done:completed',
      '4:rejected:dropped',
      '5:promoted:completed',
    ])
  })

  it('AC3: removes implementing where no live subject uses it, and keeps it where one does', async () => {
    const empty = await before084()
    await file(empty.client, 'Exploring something', 'exploring')
    await apply(empty.client, empty.rest)
    expect(await stageId(empty.client, 'implementing')).toBeUndefined()
    expect(await stageId(empty.client, 'promoted')).toBeDefined()

    const used = await before084()
    const seen = notices(used.client)
    await file(used.client, 'Still in delivery', 'implementing')
    await apply(used.client, used.rest)
    const names = (await board(used.client)).map((r) => r.split(':')[1])
    expect(names).toContain('implementing')
    expect(names).toContain('promoted')
    for (const gone of ['to implement', 'internal testing', 'ready for rollout', 'rolled out']) expect(names).not.toContain(gone)
    expect(seen.join('\n')).toContain('implementing (1 live)')
    const row = (
      await used.client.query(
        `select st.name from subjects s join lab_stages st on st.id = s.stage_id where s.title = 'Still in delivery'`,
      )
    ).rows[0]
    expect(row).toEqual({ name: 'implementing' })
  })

  it('moves archived subjects off a retired stage into promoted, concluded, with a stage note', async () => {
    const { client, rest } = await before084()
    const owner = randomUUID()
    await client.query(`insert into app_users (id, email, encrypted_password, role) values ($1, 'p@example.test', 'x', 'admin')`, [owner])
    const project = (
      await client.query<{ id: string }>(
        `insert into projects (owner_user_id, key, title) values ($1, 'PGV', 'pgvector recall') returning id`,
        [owner],
      )
    ).rows[0]!.id
    const linked = await file(client, 'Linked', 'rolled out', { archived: true })
    await client.query('update subjects set project_id = $2 where id = $1', [linked, project])
    const kept = await file(client, 'Had an answer', 'implementing', { archived: true, conclusion: 'Shipped as KDP.' })
    const bare = await file(client, 'Nothing said', 'internal testing', { archived: true })

    await apply(client, rest)

    const rows = (
      await client.query(
        `select s.id, st.name as stage, s.conclusion, s.concluded_at is not null as concluded, s.archived_at is not null as archived
           from subjects s join lab_stages st on st.id = s.stage_id`,
      )
    ).rows
    const by = (id: string) => rows.find((r) => r.id === id)
    expect(by(linked)).toEqual({ id: linked, stage: 'promoted', conclusion: 'Promoted to project PGV (pgvector recall)', concluded: true, archived: true })
    expect(by(kept)).toMatchObject({ stage: 'promoted', conclusion: 'Shipped as KDP.', concluded: true })
    expect(by(bare)).toMatchObject({
      stage: 'promoted',
      conclusion: "Was in internal testing when the Lab's delivery stages were retired (migration 084).",
    })
    const note = (await client.query(`select kind, note from subject_notes where subject_id = $1`, [bare])).rows
    expect(note).toEqual([{ kind: 'stage', note: 'internal testing → promoted' }])
    expect(await stageId(client, 'implementing')).toBeUndefined()
  })

  it('keeps a promoted stage an administrator already made, and makes it completed', async () => {
    const { client, rest } = await before084()
    await client.query(`insert into lab_stages (name, category, color, position) values ('Promoted', 'active', '#112233', 3)`)
    await apply(client, rest)
    const stages = (await client.query(`select name, category, color from lab_stages where lower(name) = 'promoted'`)).rows
    expect(stages).toEqual([{ name: 'Promoted', category: 'completed', color: '#112233' }])
  })

  it('can run twice: the second run changes nothing', async () => {
    const { client, rest } = await before084()
    await file(client, 'Still in delivery', 'implementing')
    await apply(client, rest)
    const once = await board(client)
    await apply(client, [MIGRATION])
    expect(await board(client)).toEqual(once)
  })
})
