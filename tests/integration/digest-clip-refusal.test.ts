import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * `PATCH /tasks/{ref}` against a real database and the actual route (PR #145):
 * a description that is the digest's clipped body sent back is refused, so
 * `update --body` cannot silently drop the tail of a long description.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { PATCH as patchTask } from '@/app/api/v1/tasks/[ref]/route'
import { BODY_BUDGET } from '@/lib/api/digest'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const KEY = `DC${String(Date.now()).slice(-6)}`
const AUTHOR = 'claude-code · Clip'

const paragraph = 'The importer reads each row, checks it against the schema and files what it finds.\n\n'
const longBody = `## What\n\n${paragraph.repeat(Math.ceil((BODY_BUDGET * 2) / paragraph.length))}`.trimEnd()

const taskIds: Record<string, string> = {}

const addTask = async (number: number, description: string | null) => {
  const id = randomUUID()
  taskIds[`${KEY}-${number}`] = id
  await pool().query(
    `insert into tasks (id, project_id, number, title, description, actor_type, actor_id)
     values ($1,$2,$3,'Clipped body',$4,'agent',$5)`,
    [id, projectId, number, description, AUTHOR],
  )
  return `${KEY}-${number}`
}

const patch = async (ref: string, body: unknown) => {
  const response = await patchTask(
    new Request(`https://cairn.example.test/api/v1/tasks/${ref}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ ref }) },
  )
  const json = await response.json()
  return { status: response.status, json }
}

const stored = async (ref: string) =>
  (await pool().query<{ description: string | null }>('select description from tasks where id = $1', [taskIds[ref]]))
    .rows[0].description

beforeAll(async () => {
  auth.actor = {
    userId: ownerId,
    actorType: 'agent',
    actorId: AUTHOR,
    userDisplayName: 'Clip',
    role: 'admin',
    rateKey: `digest-clip-${randomUUID()}`,
    sessionId: null,
  }
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId,
    `digest-clip-${ownerId}@example.test`,
    'not-used',
    'admin',
  ])
  await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,'Digest clip')`, [
    projectId,
    ownerId,
    KEY,
  ])
})

afterAll(async () => {
  await pool().query('delete from task_activity_events where owner_user_id = $1', [ownerId])
  await pool().query('delete from projects where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('PATCH /tasks/{ref} with a description', () => {
  it('refuses the digest clip of a long description and leaves it unchanged', async () => {
    expect(longBody.length).toBeGreaterThan(BODY_BUDGET)
    const ref = await addTask(1, longBody)

    const result = await patch(ref, { description: `${longBody.slice(0, BODY_BUDGET)}…` })
    expect(result.status).toBe(400)
    expect(result.json.code).toBe('validation_failed')
    expect(result.json.error).toContain(`cairn show ${ref} --full`)
    expect(await stored(ref)).toBe(longBody)
  })

  it('accepts a full edited body', async () => {
    const ref = await addTask(2, longBody)
    const edited = `${longBody}\n\nAnd one more paragraph.`

    const result = await patch(ref, { description: edited })
    expect(result.status).toBe(200)
    expect(await stored(ref)).toBe(edited)
  })

  it('accepts a short body ending in an ellipsis when the stored one fits the budget', async () => {
    const ref = await addTask(3, 'A short description that fits the digest.')

    const result = await patch(ref, { description: 'To be continued…' })
    expect(result.status).toBe(200)
    expect(await stored(ref)).toBe('To be continued…')
  })
})
