import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 079 and 080 (CAIRN-384): `under construction` joins the board only where the
 * stages are still exactly the untouched default set, and `subject_promoted`
 * joins the activity event kinds without dropping one.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const clients: Client[] = []

const freshDatabase = async () => {
  const name = `cairn_lc_${randomUUID().replaceAll('-', '')}`
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

/**
 * An instance migrated up to, not including, the lifecycle migration. `rest`
 * stops before 084, which retires the delivery stages these boards still have
 * (lab-promoted-migration.test.ts).
 */
const before079 = async () => {
  const client = await freshDatabase()
  const all = await files()
  await apply(client, all.filter((f) => f < '079_'))
  return { client, rest: all.filter((f) => f >= '079_' && f < '084_') }
}

const board = async (client: Client) =>
  (await client.query('select name, position from lab_stages order by position, name')).rows.map(
    (r) => `${r.position}:${r.name}`,
  )

const DEFAULTS = [
  '0:to explore',
  '1:exploring',
  '2:done',
  '3:rejected',
  '4:to implement',
  '5:implementing',
  '6:internal testing',
  '7:ready for rollout',
  '8:rolled out',
]

afterAll(async () => {
  for (const client of clients) await client.end()
})

describe('migration 079: the under construction stage', () => {
  it('is seeded first, as a planned stage, where the stages are the untouched defaults', async () => {
    const { client, rest } = await before079()
    expect(await board(client)).toEqual(DEFAULTS)

    await apply(client, rest)

    expect(await board(client)).toEqual([
      '0:under construction',
      '1:to explore',
      '2:exploring',
      '3:done',
      '4:rejected',
      '5:to implement',
      '6:implementing',
      '7:internal testing',
      '8:ready for rollout',
      '9:rolled out',
    ])
    const stage = (await client.query(`select category, color from lab_stages where name = 'under construction'`)).rows[0]
    expect(stage).toEqual({ category: 'planned', color: '#7d8590' })
  })

  it('leaves a curated board alone: a rename, a recolour, a reorder or an addition', async () => {
    const edits: [string, string][] = [
      ['renamed', `update lab_stages set name = 'to look at' where name = 'to explore'`],
      ['recoloured', `update lab_stages set color = '#112233' where name = 'done'`],
      ['recategorised', `update lab_stages set category = 'active' where name = 'to implement'`],
      ['reordered', `update lab_stages set position = 10 where name = 'rejected'`],
      ['added to', `insert into lab_stages (name, category, position) values ('on hold', 'planned', 9)`],
      ['pruned', `delete from lab_stages where name = 'rolled out'`],
    ]
    for (const [what, edit] of edits) {
      const { client, rest } = await before079()
      await client.query(edit)
      const curated = await board(client)

      await apply(client, rest)

      expect(await board(client), `a board that was ${what}`).toEqual(curated)
    }
  })

  it('can run twice: the second run finds the stage and changes nothing', async () => {
    const { client, rest } = await before079()
    await apply(client, rest)
    const once = await board(client)
    await apply(client, rest)
    expect(await board(client)).toEqual(once)
  })

  it('treats a case-insensitive match as the stage being there already', async () => {
    const { client, rest } = await before079()
    await client.query(`insert into lab_stages (name, category, position) values ('Under Construction', 'planned', 9)`)
    const curated = await board(client)
    await apply(client, rest)
    expect(await board(client)).toEqual(curated)
  })

  it('moves subjects with their stage: a stage in use is only shifted, never replaced', async () => {
    const { client, rest } = await before079()
    const stage = (await client.query(`select id from lab_stages where name = 'exploring'`)).rows[0].id
    await client.query(
      `insert into subjects (title, stage_id, actor_type, actor_id) values ('In flight', $1, 'agent', 'a')`,
      [stage],
    )

    await apply(client, rest)

    const row = (
      await client.query(
        `select st.name, st.position from subjects s join lab_stages st on st.id = s.stage_id where s.title = 'In flight'`,
      )
    ).rows[0]
    expect(row).toEqual({ name: 'exploring', position: 2 })
  })
})

describe('migrations 079 and 080: the subject_promoted event', () => {
  const definition = async (client: Client) =>
    (
      await client.query<{ d: string; convalidated: boolean }>(
        `select pg_get_constraintdef(oid) as d, convalidated from pg_constraint where conname = 'task_activity_events_event_check'`,
      )
    ).rows[0]!
  const kinds = (def: string) => [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()

  it('is added without dropping a kind, NOT VALID in 079 and validated in 080', async () => {
    const { client } = await before079()
    const earlier = await definition(client)
    expect(kinds(earlier.d)).not.toContain('subject_promoted')

    await apply(client, ['079_lab_lifecycle.sql'])
    const added = await definition(client)
    expect(added.convalidated).toBe(false)
    expect(kinds(added.d)).toEqual([...kinds(earlier.d), 'subject_promoted'].sort())

    await apply(client, ['080_validate_subject_promoted.sql'])
    expect((await definition(client)).convalidated).toBe(true)
    await client.query(`insert into task_activity_events (actor_type, actor_id, event) values ('agent', 'a', 'subject_promoted')`)
  })
})
