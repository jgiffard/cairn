import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * `PATCH /tasks/{ref}/comments/{id}` against a real database and the actual
 * route (CAIRN-391): only the author edits, an unknown id is a 404, an archived
 * task is refused, and the edit is recorded as `comment_edited`.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { PATCH as patchComment } from '@/app/api/v1/tasks/[ref]/comments/[id]/route'
import { GET as listComments, POST as postComment } from '@/app/api/v1/tasks/[ref]/comments/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()
const KEY = `CE${String(Date.now()).slice(-6)}`
const REF = `${KEY}-1`
const AUTHOR = 'claude-code · Editor'
const OTHER = 'codex · Editor'

const as = (actorType: 'agent' | 'human', actorId: string) => {
  auth.actor = {
    userId: ownerId,
    actorType,
    actorId,
    userDisplayName: 'Editor',
    role: 'admin',
    rateKey: `comment-edit-${randomUUID()}`,
    sessionId: null,
  }
}

const url = `https://cairn.example.test/api/v1/tasks/${REF}/comments`
const init = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

const post = async (content: string) => {
  const response = await postComment(new Request(url, init('POST', { content })), {
    params: Promise.resolve({ ref: REF }),
  })
  return (await response.json()).data as { id: string }
}

const patch = async (id: string, body: unknown) => {
  const response = await patchComment(new Request(`${url}/${id}`, init('PATCH', body)), {
    params: Promise.resolve({ ref: REF, id }),
  })
  const json = await response.json()
  return { status: response.status, json, data: json?.data }
}

const edits = async () =>
  (
    await pool().query<{ actor_id: string; data: { comment_id: string } }>(
      `select actor_id, data from task_activity_events where task_id = $1 and event = 'comment_edited' order by created_at`,
      [taskId],
    )
  ).rows

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId,
    `comment-edit-${ownerId}@example.test`,
    'not-used',
    'admin',
  ])
  await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,'Comment edit')`, [
    projectId,
    ownerId,
    KEY,
  ])
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id) values ($1,$2,1,'Edit a comment','agent',$3)`,
    [taskId, projectId, AUTHOR],
  )
})

afterAll(async () => {
  await pool().query('delete from task_activity_events where owner_user_id = $1', [ownerId])
  await pool().query('delete from projects where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('PATCH /tasks/{ref}/comments/{id}', () => {
  it('lets the author edit, stamps edited_at, and records the event', async () => {
    as('agent', AUTHOR)
    const { id } = await post('first draft')

    const result = await patch(id, { content: 'second draft' })
    expect(result.status).toBe(200)
    expect(result.data.content).toBe('second draft')
    expect(result.data.edited_at).toBeTruthy()
    expect(await edits()).toEqual([{ actor_id: AUTHOR, data: { comment_id: id } }])

    const listed = await listComments(new Request(url), { params: Promise.resolve({ ref: REF }) })
    const row = (await listed.json()).data.find((c: { id: string }) => c.id === id)
    expect(row.content).toBe('second draft')
    expect(row.edited_at).toBeTruthy()
  })

  it('returns edited_at as null for a comment nobody edited', async () => {
    as('agent', AUTHOR)
    const { id } = await post('never touched')
    const listed = await listComments(new Request(url), { params: Promise.resolve({ ref: REF }) })
    const row = (await listed.json()).data.find((c: { id: string }) => c.id === id)
    expect(row.edited_at).toBeNull()
  })

  it('refuses anyone else with 403 not_author, and changes nothing', async () => {
    as('agent', AUTHOR)
    const { id } = await post('mine')
    const before = (await edits()).length

    as('agent', OTHER)
    const other = await patch(id, { content: 'hijacked' })
    expect(other.status).toBe(403)
    expect(other.json.code).toBe('not_author')

    as('human', AUTHOR)
    expect((await patch(id, { content: 'same name, a person' })).status).toBe(403)

    const { rows } = await pool().query('select content, edited_at from task_comments where id = $1', [id])
    expect(rows[0]).toEqual({ content: 'mine', edited_at: null })
    expect(await edits()).toHaveLength(before)
  })

  it('is a 404 for an id the task does not have', async () => {
    as('agent', AUTHOR)
    const result = await patch(randomUUID(), { content: 'nothing here' })
    expect(result.status).toBe(404)
    expect(result.json.code).toBe('not_found')
  })

  it('is a 404, not a 500, for an id that is not a uuid', async () => {
    as('agent', AUTHOR)
    const result = await patch('abc', { content: 'nothing here' })
    expect(result.status).toBe(404)
    expect(result.json.code).toBe('not_found')
  })

  it('records nothing when the text did not change', async () => {
    as('agent', AUTHOR)
    const { id } = await post('unchanged')
    const before = (await edits()).length
    const result = await patch(id, { content: 'unchanged' })
    expect(result.status).toBe(200)
    expect(result.data.edited_at).toBeNull()
    expect(await edits()).toHaveLength(before)
  })

  it('refuses an archived task like POST does', async () => {
    as('agent', AUTHOR)
    const { id } = await post('before the archive')
    await pool().query(`update projects set status = 'archived' where id = $1`, [projectId])
    try {
      const result = await patch(id, { content: 'too late' })
      expect(result.status).toBe(409)
      const { rows } = await pool().query('select content from task_comments where id = $1', [id])
      expect(rows[0].content).toBe('before the archive')
    } finally {
      await pool().query(`update projects set status = 'active' where id = $1`, [projectId])
    }
  })
})
