import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The write paths the CLI's coverage work reaches that had no secret check
 * (CAIRN-383): projects and entities refuse a credential in their free text,
 * while a session — posted by a hook nobody watches — is redacted and still
 * recorded, even when the credential is in `request`.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { POST as createProject } from '@/app/api/v1/projects/route'
import { PATCH as patchProject } from '@/app/api/v1/projects/[id]/route'
import { POST as createEntity, PATCH as patchEntity, DELETE as deleteEntity } from '@/app/api/v1/entities/route'
import { POST as postSession } from '@/app/api/v1/sessions/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const KEY = `WS${suffix}`
const ENTITY = `ws-${suffix}`
const SESSION = `ws-session-${suffix}`

// Built at run time: a key-shaped literal in the source is what push protection
// blocks, and what a scanner reports against this file.
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const LEAK = `deploy with ${TOKEN} from the runner`

const as = (actorType: 'agent' | 'human') => {
  auth.actor = {
    userId: ownerId,
    actorType,
    actorId: actorType === 'agent' ? 'claude-code · secrets@example.test' : 'Secrets',
    userDisplayName: 'Secrets',
    role: 'admin',
    rateKey: `secrets-${randomUUID()}`,
    sessionId: null,
    agentName: actorType === 'agent' ? 'claude-code' : undefined,
  }
}

const send = async <P>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  params?: P,
) => {
  const response = await handler(
    new Request(`https://cairn.example.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve((params ?? {}) as P) },
  )
  const json = await response.json()
  return { status: response.status, json, data: json?.data }
}

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId,
    `secrets-${ownerId}@example.test`,
    'not-used',
    'admin',
  ])
})

afterAll(async () => {
  await pool().query('delete from sessions where owner_user_id = $1', [ownerId])
  await pool().query('delete from entities where key = $1', [ENTITY])
  await pool().query('delete from projects where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('projects', () => {
  it('refuse a credential in the description on create and on edit, naming the field', async () => {
    as('agent')
    const refusedCreate = await send(createProject, 'POST', '/api/v1/projects', {
      key: KEY,
      title: 'Secrets',
      description: LEAK,
    })
    expect(refusedCreate.status).toBe(400)
    expect(refusedCreate.json.code).toBe('secret_detected')
    expect(refusedCreate.json.field).toBe('description')
    expect(JSON.stringify(refusedCreate.json)).not.toContain(TOKEN)

    const created = await send(createProject, 'POST', '/api/v1/projects', { key: KEY, title: 'Secrets' })
    expect(created.status).toBe(201)

    const refusedEdit = await send(patchProject, 'PATCH', `/api/v1/projects/${KEY}`, { title: LEAK }, { id: KEY })
    expect(refusedEdit.status).toBe(400)
    expect(refusedEdit.json.code).toBe('secret_detected')
    expect(refusedEdit.json.field).toBe('title')
  })

  it('take every status the web app offers', async () => {
    as('agent')
    for (const status of ['planning', 'paused', 'completed', 'active', 'archived']) {
      const result = await send(patchProject, 'PATCH', `/api/v1/projects/${KEY}`, { status }, { id: KEY })
      expect(result.status, status).toBe(200)
      expect(result.data.status).toBe(status)
    }
  })
})

describe('entities', () => {
  it('refuse a credential in the description on create and on edit', async () => {
    as('agent')
    const refused = await send(createEntity, 'POST', '/api/v1/entities', {
      key: ENTITY,
      title: 'Secrets',
      description: LEAK,
    })
    expect(refused.status).toBe(400)
    expect(refused.json.code).toBe('secret_detected')
    expect(refused.json.field).toBe('description')

    const created = await send(createEntity, 'POST', '/api/v1/entities', { key: ENTITY, title: 'Secrets' })
    expect(created.status).toBeLessThan(300)

    const refusedEdit = await send(patchEntity, 'PATCH', '/api/v1/entities', { key: ENTITY, description: LEAK })
    expect(refusedEdit.status).toBe(400)
    expect(refusedEdit.json.code).toBe('secret_detected')
  })

  it('delete by key, and say what was unlinked', async () => {
    as('agent')
    const gone = await send(deleteEntity, 'DELETE', `/api/v1/entities?key=${ENTITY}`)
    expect(gone.status).toBe(200)
    expect(gone.data.deleted).toBe(ENTITY)
    expect((await send(deleteEntity, 'DELETE', `/api/v1/entities?key=${ENTITY}`)).status).toBe(404)
  })
})

describe('sessions', () => {
  it('still record a session whose request holds a key, with the key redacted', async () => {
    as('agent')
    const ended = await send(postSession, 'POST', '/api/v1/sessions', {
      externalId: SESSION,
      platformSource: 'claude',
      request: LEAK,
      learned: `found ${TOKEN} in the log`,
      completed: 'rotated it',
      nextSteps: 'nothing',
    })

    expect(ended.status).toBe(200)
    expect(ended.data.id).toBeTruthy()
    expect(ended.data.redactions.length).toBeGreaterThan(0)

    const { rows } = await pool().query<{ request: string; learned: string }>(
      'select request, learned from sessions where id = $1',
      [ended.data.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request).not.toContain(TOKEN)
    expect(rows[0]!.learned).not.toContain(TOKEN)
    expect(rows[0]!.request).toContain('deploy with')
  })
})
