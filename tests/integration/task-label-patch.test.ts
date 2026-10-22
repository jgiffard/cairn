import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))
vi.mock('@/lib/api/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api/auth')>(), authenticate: async () => auth.actor,
}))

import { pool } from '@/lib/db/client'
import { PATCH } from '@/app/api/v1/tasks/[ref]/route'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')
const owner = randomUUID()
const projects = [randomUUID(), randomUUID(), randomUUID()]
const keys = ['LP', 'LM', 'LL'].map((key) => `${key}${Date.now().toString().slice(-6)}`)
let number = 0
const update = (ref: string, body: Record<string, unknown>) => PATCH(new Request(`https://cairn.example.test/api/v1/tasks/${ref}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer test' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ ref }) })
const create = async (labels: string[] = ['a']) => {
  const id = randomUUID()
  await pool().query(`insert into tasks(id, project_id, number, title, labels, actor_type, actor_id)
    values ($1,$2,$3,'Original',$4,'human','label-test')`, [id, projects[0], ++number, labels])
  return id
}
const stored = async (id: string) => (await pool().query('select * from tasks where id = $1', [id])).rows[0]
const events = async (id: string) => (await pool().query("select data from task_activity_events where task_id = $1 and event = 'labels_changed'", [id])).rows

beforeAll(async () => {
  await pool().query("insert into app_users(id,email,encrypted_password,role) values ($1,$2,'unused','admin')", [owner, `labels-${owner}@example.test`])
  for (let i = 0; i < projects.length; i++) {
    await pool().query("insert into projects(id,owner_user_id,key,title) values ($1,$2,$3,'Labels')", [projects[i], owner, keys[i]])
  }
})
beforeEach(() => {
  auth.actor = { userId: owner, actorType: 'human', actorId: 'label-test', userDisplayName: 'Labels', role: 'admin', rateKey: randomUUID(), sessionId: null }
})
afterAll(async () => {
  await pool().query('delete from tasks where project_id = any($1::uuid[])', [projects])
  await pool().query('delete from projects where id = any($1::uuid[])', [projects])
  await pool().query('delete from app_users where id = $1', [owner])
  await pool().end()
})

describe('atomic task label patches', () => {
  it('keeps every concurrent addition and records the actual before and after', async () => {
    const id = await create()
    const names = Array.from({ length: 10 }, (_, i) => `label-${i}`)
    const responses = await Promise.all(names.map((name) => update(id, { labelPatch: { add: [name] } })))
    expect(responses.map((r) => r.status)).toEqual(names.map(() => 200))
    expect(new Set((await stored(id)).labels)).toEqual(new Set(['a', ...names]))
    const changes = await events(id)
    expect(changes).toHaveLength(10)
    expect(changes.map((e) => e.data.from.length).sort((a, b) => a - b)).toEqual([1,2,3,4,5,6,7,8,9,10])
    for (const { data } of changes) expect(data.to).toHaveLength(data.from.length + 1)
  })

  it('combines add and remove with other fields and reports the delta', async () => {
    const id = await create(['a', 'b'])
    const response = await update(id, { title: 'Changed', labelPatch: { add: ['c'], remove: ['a'] } })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ title: 'Changed', labels: ['b', 'c'], labelPatch: {
      added: ['c'], removed: ['a'], alreadyPresent: [], alreadyAbsent: [],
    } })
    expect((await stored(id)).labels).toEqual(['b', 'c'])
    expect((await events(id))[0].data).toEqual({ from: ['a', 'b'], to: ['b', 'c'] })
  })

  it('returns the same public keys and normalized timestamp as a plain update', async () => {
    const id = await create()
    const plain = await update(id, { title: 'Plain' })
    const delta = await update(id, { title: 'Delta', labelPatch: { add: ['x'] } })
    expect([plain.status, delta.status]).toEqual([200, 200])
    const plainData = (await plain.json()).data
    const deltaData = (await delta.json()).data
    expect(Object.keys(deltaData).filter((key) => key !== 'labelPatch').sort()).toEqual(Object.keys(plainData).sort())
    for (const data of [plainData, deltaData]) {
      expect(data).not.toHaveProperty('search_vector')
      expect(data).not.toHaveProperty('owner_user_id')
      expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(new Date(data.updated_at).toISOString()).toBe(data.updated_at)
    }
    expect(deltaData.labels).toEqual(['a', 'x'])
  })

  it('reports no-ops and retries without recording a labels event', async () => {
    const id = await create()
    const noop = await update(id, { labelPatch: { add: ['a'], remove: ['z'] } })
    expect(noop.status).toBe(200)
    expect((await noop.json()).data).toMatchObject({ labels: ['a'], labelPatch: {
      added: [], removed: [], alreadyPresent: ['a'], alreadyAbsent: ['z'],
    } })
    expect(await events(id)).toEqual([])
    await update(id, { labelPatch: { add: ['x'] } })
    const retry = await update(id, { labelPatch: { add: ['x'] } })
    expect(retry.status).toBe(200)
    expect((await retry.json()).data.labelPatch).toEqual({ added: [], removed: [], alreadyPresent: ['x'], alreadyAbsent: [] })
    expect(await events(id)).toHaveLength(1)
  })

  it('refuses labels together with labelPatch before writing any fields', async () => {
    const id = await create()
    const response = await update(id, { title: 'No', labels: [], labelPatch: { add: ['b'] } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    expect(await stored(id)).toMatchObject({ labels: ['a'], title: 'Original' })
  })

  it('refuses empty patches and invalid label names', async () => {
    const id = await create()
    for (const labelPatch of [{}, { add: [], remove: [] }, { add: [''] }, { remove: ['x'.repeat(51)] }]) {
      const response = await update(id, { labelPatch })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    }
    expect((await stored(id)).labels).toEqual(['a'])
  })

  it('rolls back overflow including other fields moves and links', async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const id = await create(labels)
    const response = await update(id, { title: 'No', project: keys[1], alsoProjects: [keys[2]], labelPatch: { add: ['overflow'] } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    expect(await stored(id)).toMatchObject({ labels, title: 'Original', project_id: projects[0] })
    expect((await pool().query('select * from task_projects where task_id = $1', [id])).rows).toEqual([])
    expect(await events(id)).toEqual([])
    // Removing one makes room, even if add arrives before remove in JSON.
    expect((await update(id, { labelPatch: { add: ['replacement'], remove: ['l0'] } })).status).toBe(200)
    expect((await stored(id)).labels).toEqual([...labels.slice(1), 'replacement'])
  })

  it('deduplicates additions and preserves existing and requested order and case', async () => {
    const id = await create(['b', 'a'])
    const response = await update(id, { labelPatch: { add: ['x', 'x', 'y', 'a', 'A'] } })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ labels: ['b', 'a', 'x', 'y', 'A'], labelPatch: {
      added: ['x', 'y', 'A'], removed: [], alreadyPresent: ['a'], alreadyAbsent: [],
    } })
  })

  it('refuses a name in both add and remove', async () => {
    const id = await create()
    const response = await update(id, { labelPatch: { add: ['x'], remove: ['x'] } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    expect((await stored(id)).labels).toEqual(['a'])
  })

  it('keeps a concurrent add and remove of different labels', async () => {
    const id = await create(['a', 'y'])
    const responses = await Promise.all([
      update(id, { labelPatch: { add: ['x'] } }), update(id, { labelPatch: { remove: ['y'] } }),
    ])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    expect((await stored(id)).labels).toEqual(['a', 'x'])
  })

  it('uses the existing archived missing and authentication refusals without writes', async () => {
    const id = await create()
    await pool().query("update projects set status = 'archived' where id = $1", [projects[0]])
    try {
      const plain = await update(id, { title: 'No' })
      const delta = await update(id, { labelPatch: { add: ['x'] } })
      expect(delta.status).toBe(plain.status)
      expect(await delta.json()).toEqual(await plain.json())
      expect((await stored(id)).labels).toEqual(['a'])
    } finally {
      await pool().query("update projects set status = 'active' where id = $1", [projects[0]])
    }
    expect((await update(randomUUID(), { labelPatch: { add: ['x'] } })).status).toBe(404)
    auth.actor = null
    expect((await update(id, { labelPatch: { add: ['x'] } })).status).toBe(401)
    expect((await stored(id)).labels).toEqual(['a'])
    expect(await events(id)).toEqual([])
  })

  it('applies handoff and resolution refusals before changing labels', async () => {
    const id = await create()
    for (const fields of [{ status: 'done' }, { resolution: 'Cannot settle an open task' }]) {
      expect((await update(id, { ...fields, labelPatch: { add: ['x'] } })).status).toBe(400)
    }
    await pool().query("update tasks set handoff_tracker = 'github', handoff_ref = 'repo/1' where id = $1", [id])
    expect((await update(id, { status: 'todo', labelPatch: { add: ['x'] } })).status).toBe(409)
    expect((await stored(id)).labels).toEqual(['a'])
  })

  it('combines successful label updates moves and project links', async () => {
    const id = await create()
    const response = await update(id, { project: keys[1], alsoProjects: [keys[2]], labelPatch: { add: ['x'] } })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ labels: ['a', 'x'], moved: { from: keys[0] }, alsoProjects: [keys[2]] })
    expect(await stored(id)).toMatchObject({ project_id: projects[1], labels: ['a', 'x'] })
    expect((await pool().query('select project_id from task_projects where task_id = $1', [id])).rows).toEqual([{ project_id: projects[2] }])
  })
})
