import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { recallCounts, unusedKnowledge } from '@/lib/api/knowledge-use'

/**
 * Per-entry recall counts (CAIRN-270), from the rows 053 records, against the
 * installed `knowledge_recall_counts`.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const AGENT = 'claude-code · counts@example.test'
const slug = (name: string) => `counts-${name}-${suffix}`
const ids: Record<string, string> = {}

const entry = async (name: string, age: string) => {
  const { rows } = await pool().query(
    `insert into knowledge (owner_user_id, slug, title, body, actor_type, actor_id, created_at)
     values ($1, $2, $3, '', 'agent', $4, now() - $5::interval) returning id`,
    [ownerId, slug(name), `Counts ${name}`, AGENT, age],
  )
  ids[name] = rows[0].id as string
}

const searched = (returned: string[], age = '1 day') =>
  pool().query(
    `insert into search_events (owner_user_id, actor_id, query, kinds, result_count, widened, returned_slugs, created_at)
     values ($1, $2, 'q', null, $3, false, $4, now() - $5::interval)`,
    [ownerId, AGENT, returned.length, returned, age],
  )

const read = (spelled: string, hit: boolean, age = '1 day') =>
  pool().query(
    `insert into knowledge_reads (owner_user_id, actor_id, slug, hit, created_at)
     values ($1, $2, $3, $4, now() - $5::interval)`,
    [ownerId, AGENT, spelled, hit, age],
  )

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `counts-${ownerId}@example.test`,
    'not-used',
  ])
  await entry('busy', '90 days')
  await entry('stale', '90 days')
  await entry('forgotten', '90 days')
  await entry('young', '2 days')
  await entry('older-recalled', '90 days')
  await entry('never-recalled-limited', '60 days')

  await searched([slug('busy'), 'CAIRN-1', slug('busy')])
  await searched([slug('busy')], '2 days')
  await read(slug('busy'), true)
  // Spelled the way [[a_b]] references are, and resolved on read.
  await read(slug('busy').replace(/-/g, '_'), true)
  await read(slug('busy'), false)

  await searched([slug('stale')], '60 days')
  await searched([slug('older-recalled')], '45 days')
})

afterAll(async () => {
  await pool().query('delete from search_events where owner_user_id = $1', [ownerId])
  await pool().query('delete from knowledge_reads where owner_user_id = $1', [ownerId])
  await pool().query('delete from knowledge where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('recall counts', () => {
  it('counts searches that returned an entry and hits that read it, underscores included', async () => {
    const counts = await recallCounts([ids.busy!])
    // Listed twice in one search counts twice: it was returned in two rows.
    expect(counts.get(ids.busy!)).toMatchObject({ returned: 3, read: 2 })
    expect(counts.get(ids.busy!)?.lastRecalled).not.toBeNull()
  })

  it('counts only inside the window', async () => {
    expect((await recallCounts([ids.stale!])).get(ids.stale!)).toMatchObject({ returned: 0, read: 0 })
    expect((await recallCounts([ids.stale!], 90)).get(ids.stale!)).toMatchObject({ returned: 1 })
  })

  it('lists what nobody was given, never-recalled first, and not what is too young to judge', async () => {
    const unused = (await unusedKnowledge(30, 200)).map((u) => u.slug).filter((s) => s.endsWith(suffix))
    expect(unused).toEqual([slug('forgotten'), slug('stale')])

    const stale = (await unusedKnowledge(30, 200)).find((u) => u.slug === slug('stale'))
    expect(stale?.lastRecalled).not.toBeNull()
  })

  it('does not let an older recalled entry crowd out a never-recalled entry at limit one', async () => {
    const only = (await unusedKnowledge(30, 1)).find((u) => u.slug.endsWith(suffix))
    expect(only?.slug).toBe(slug('never-recalled-limited'))
    expect(only?.lastRecalled).toBeNull()
  })
})
