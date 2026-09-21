import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, pool } from '@/lib/db/client'

/**
 * `--mine` means this session, not this human.
 *
 * `claimed_by` is an actorLabel — `claude-code · cal@example.com` — and every
 * Claude Code session on a machine writes exactly that. Four run on the
 * machine this was written for, so `--mine` answered "this human's agents"
 * while reading like "this session".
 *
 * Proved here rather than in a unit test because the risk is not the intent,
 * it is the expression: the route AND-s a `claimed_by` equality with an OR
 * group over `claimed_session`, and whether the adapter composes those two
 * into the right SQL is a question only a database can answer. It already
 * carries one `or` for guest projects, so this is the second group in the
 * same query.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const ME = 'claude-code · mine-filter@example.test'
const MY_SESSION = 'session-mine'

/** ref -> the session its claim names. */
const CLAIMS: [string, string | null][] = [
  ['mine', MY_SESSION],
  ['sibling', 'session-other'],
  ['unnamed', null],
]
const ids = new Map<string, string>()

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `mine-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title) values ($1,$2,'MINE','Mine')`,
    [projectId, ownerId],
  )
  let number = 0
  for (const [name, session] of CLAIMS) {
    const id = randomUUID()
    ids.set(name, id)
    number += 1
    await pool().query(
      `insert into tasks (id, project_id, number, title, status, type, actor_id, claimed_by, claimed_session, heartbeat_at)
       values ($1,$2,$3,$4,'doing','chore',$5,$5,$6, now())`,
      [id, projectId, number, name, ME, session],
    )
  }
  // Held by a different agent entirely, which must never appear.
  await pool().query(
    `insert into tasks (id, project_id, number, title, status, type, actor_id, claimed_by, claimed_session, heartbeat_at)
     values ($1,$2,99,'stranger','doing','chore','codex · someone','codex · someone',$3, now())`,
    [randomUUID(), projectId, MY_SESSION],
  )
})

afterAll(async () => {
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
})

/** Exactly what the route builds for `mine=true`. */
const mine = async (session: string | null) => {
  let query = admin().from('tasks').select('title').eq('project_id', projectId).eq('claimed_by', ME)
  if (session) query = query.or(`claimed_session.is.null,claimed_session.eq.${session}`)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return ((data ?? []) as { title: string }[]).map((r) => r.title).sort()
}

describe('the mine filter', () => {
  it('leaves a sibling session’s claim out', async () => {
    expect(await mine(MY_SESSION)).toEqual(['mine', 'unnamed'])
  })

  it('keeps a claim that names no session', async () => {
    // It predates the column or came from a runtime that cannot name itself.
    // "Cannot tell" must not become "not yours", or every claim made before
    // this existed would vanish from --mine at once.
    expect(await mine(MY_SESSION)).toContain('unnamed')
  })

  it('answers for the whole label when the caller has no session', async () => {
    // Codex and OpenClaw may not have one. They see what they always saw.
    expect(await mine(null)).toEqual(['mine', 'sibling', 'unnamed'])
  })

  it('never reaches another agent, whatever the session', async () => {
    expect(await mine(MY_SESSION)).not.toContain('stranger')
    expect(await mine(null)).not.toContain('stranger')
  })
})
