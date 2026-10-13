import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { searchAll, searchTasks } from '@/lib/api/search'

/**
 * Another tracker's ref finds the task that is that issue (CAIRN-413).
 *
 * The observed case: `DIS-2237` on an instance whose project is DISPOF ranked
 * the imported task 9th of 11, under short rows titled with the ref, because
 * its only mention was an import footer at the end of a 25 KB description and
 * 064 ranks by density. Against the installed SQL, because the trailing-ref
 * expression and migration 085's index are the part a unit test cannot see.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const suffix = String(Date.now()).slice(-4)
const KEY = `XT${suffix}`
const AGENT = 'claude-code · search-external-ref@example.test'
// external_ref is unique per instance, so every ref carries this run's number,
// in the six digits a ref query allows.
const n = (base: number) => base * 10_000 + Number(suffix)
const LINEAR = `DIS-${n(9)}`
const SLUG = `search-external-ref-${suffix}`

const insertTask = async (number: number, externalRef: string, description = '', updatedAt = 'now()') => {
  const { rows } = await pool().query(
    `insert into tasks (id, project_id, number, title, description, actor_type, actor_id, external_ref, updated_at)
     values ($1, $2, $3, $4, $5, 'agent', $6, $7, ${updatedAt}) returning id`,
    [randomUUID(), projectId, number, `Imported ${number}`, description, AGENT, externalRef],
  )
  return rows[0].id as string
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  const { rows: clash } = await pool().query(`select 1 from projects where key in ('DIS', 'T', 'LEGACY', 'DISPOF')`)
  if (clash.length > 0) throw new Error('a DIS, T, LEGACY or DISPOF project exists here, so these refs would resolve natively')

  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId, `search-external-ref-${ownerId}@example.test`, 'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'External ref search',20)`,
    [projectId, ownerId, KEY],
  )

  const filler = 'Deals created by a seller are no longer auto-assigned to them. '.repeat(400)
  ids.linear = await insertTask(1, `linear.app/${LINEAR}`, `${filler}\n\n*Imported from Linear ${LINEAR}*`)
  ids.croftOld = await insertTask(2, `croft:croft.montytorr.com/T-${n(1)}`, '', `now() - interval '2 days'`)
  ids.croftNew = await insertTask(3, `linear.app/t-${n(1)}`, '', `now() - interval '1 day'`)
  ids.handoff = await insertTask(4, `cairn.app.dispofi.fr/DISPOF-${n(12)}`)
  ids.bare = await insertTask(5, `LEGACY-${n(37)}`)

  await pool().query(
    `insert into knowledge (owner_user_id, slug, title, body, actor_type, actor_id)
     values ($1, $2, $3, 'Short.', 'agent', $4)`,
    [ownerId, SLUG, `${LINEAR} assignment notes`, AGENT],
  )
})

afterAll(async () => {
  await pool().query('delete from knowledge where owner_user_id = $1', [ownerId])
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('a ref whose key is no project here', () => {
  it('puts the long task first on the unified path, over a short entry titled with the ref, once', async () => {
    const { rows } = await searchAll(ownerId, LINEAR, {}, 20)

    expect(rows[0]).toMatchObject({ kind: 'task', id: ids.linear, ref: `${KEY}-1` })
    expect(rows.filter((r) => r.id === ids.linear)).toHaveLength(1)
    expect(rows.map((r) => r.ref)).toContain(SLUG)
  })

  it('puts it first on the task path, once', async () => {
    const { rows } = await searchTasks(ownerId, LINEAR, {}, 20)

    expect(rows[0]).toMatchObject({ id: ids.linear, project_key: KEY, number: 1 })
    expect(rows.filter((r) => r.id === ids.linear)).toHaveLength(1)
  })

  it.each([
    ['a handoff', () => `DISPOF-${n(12)}`, 'handoff'],
    ['a bare ref', () => `LEGACY-${n(37)}`, 'bare'],
    ['any spelling', () => `dis-${n(9)}`, 'linear'],
  ])('resolves %s', async (_name, query, holder) => {
    const { rows } = await searchTasks(ownerId, query(), {}, 20)
    expect(rows[0]?.id).toBe(ids[holder])
  })

  it('pins every holder of a shared tail, newest first, whatever case it was stored in', async () => {
    const { rows } = await searchAll(ownerId, `T-${n(1)}`, {}, 20)
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual([ids.croftNew, ids.croftOld])
  })

  it('drops the pinned row when a filter excludes it', async () => {
    const { rows } = await searchTasks(ownerId, LINEAR, { status: 'done' }, 20)
    expect(rows.map((r) => r.id)).not.toContain(ids.linear)
  })

  it('probes migration 085 index rather than scanning', async () => {
    const client = await pool().connect()
    try {
      await client.query('begin')
      await client.query('set local enable_seqscan = off')
      const { rows } = await client.query(
        `explain select id from tasks
          where external_ref is not null
            and upper(regexp_replace(external_ref, '^.*[/:]', '')) = $1`,
        [LINEAR],
      )
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('tasks_external_ref_tail_idx')
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
