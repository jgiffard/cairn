import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '@/lib/db/client'
import { takeTask } from '@/lib/api/claim'
import type { Actor } from '@/lib/api/auth'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()
const actor: Actor = {
  userId: ownerId, actorType: 'agent', actorId: 'codex · Renewal tester',
  userDisplayName: 'Renewal tester', role: 'member', rateKey: 'claim-renewal-integration',
  sessionId: 'session-a',
}
const readTask = async () => {
  const { rows } = await pool().query('select * from tasks where id = $1', [taskId])
  return rows[0] as { id: string } & Record<string, unknown>
}
const readEvents = async () => (await pool().query(
  'select owner_user_id, project_id, actor_type, actor_id, event, data from task_activity_events where task_id = $1 order by created_at',
  [taskId],
)).rows

beforeAll(async () => {
  await pool().query(
    'insert into app_users (id, email, encrypted_password) values ($1, $2, $3)',
    [ownerId, `renewal-${ownerId}@example.test`, 'not-used'],
  )
  await pool().query(
    'insert into projects (id, owner_user_id, key, title) values ($1, $2, $3, $4)',
    [projectId, ownerId, `R${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`, 'Claim renewal'],
  )
})

beforeEach(async () => {
  await pool().query('delete from tasks where id = $1', [taskId])
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
     values ($1, $2, 1, 'Renewal target', 'agent', $3, 'todo')`,
    [taskId, projectId, actor.actorId],
  )
  const claimed = await takeTask(actor, await readTask())
  expect(claimed.error).toBeNull()
  expect(claimed.row).toMatchObject({ attempt: 1, ownership_version: 1, claimed_session: 'session-a' })
  // Distinguish a renewed heartbeat without a timer or wall-clock sleeps.
  await pool().query("update tasks set heartbeat_at = now() - interval '1 minute' where id = $1", [taskId])
})

afterAll(async () => {
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('Postgres same-session claim renewal', () => {
  it('renews the same session preserving ownership and accepts the original beat generation', async () => {
    const before = await readTask()
    const events = await readEvents()
    const result = await takeTask(actor, before)
    expect(result.error).toBeNull()
    expect(result.row).toMatchObject({
      renewed: true, claimed_by: actor.actorId, claimed_session: actor.sessionId,
      attempt: before.attempt, ownership_version: Number(before.ownership_version),
    })
    expect(new Date(result.row!.heartbeat_at as string).getTime()).toBeGreaterThan(new Date(before.heartbeat_at as Date).getTime())
    expect(await readEvents()).toEqual(events)
    // The beat route uses this same conditional UPDATE with the queued generation.
    const beat = await pool().query(
      'update tasks set heartbeat_at = now() where id = $1 and claimed_by = $2 and ownership_version = $3 returning id',
      [taskId, actor.actorId, before.ownership_version],
    )
    expect(beat.rowCount).toBe(1)
  })

  it('keeps a different session held without touching the heartbeat or audit', async () => {
    const before = await readTask()
    const events = await readEvents()
    expect(await takeTask({ ...actor, sessionId: 'session-b' }, before)).toEqual({ row: null, error: null })
    expect(await readTask()).toEqual(before)
    expect(await readEvents()).toEqual(events)
  })

  it('lets two concurrent renewals from todo succeed with exactly one status event', async () => {
    await pool().query("update tasks set status = 'todo' where id = $1", [taskId])
    const before = await readTask()
    const eventCount = (await readEvents()).length
    const results = await Promise.all([takeTask(actor, before), takeTask(actor, before)])
    for (const result of results) {
      expect(result.error).toBeNull()
      expect(result.row).toMatchObject({
        renewed: true, status: 'doing', claimed_by: actor.actorId, attempt: before.attempt,
        ownership_version: Number(before.ownership_version),
      })
    }
    const events = await readEvents()
    expect(events.slice(eventCount)).toEqual([{
      owner_user_id: ownerId, project_id: projectId, actor_type: 'agent', actor_id: actor.actorId,
      event: 'status_changed', data: { from: 'todo', to: 'doing', via: 'claim' },
    }])
    expect(events.filter((event) => event.event === 'claimed')).toHaveLength(1)
    expect(await readTask()).toMatchObject({ claimed_by: actor.actorId, attempt: 1, ownership_version: '1' })
  })

  it('preserves status without an event when setDoing is false', async () => {
    await pool().query("update tasks set status = 'in-review' where id = $1", [taskId])
    const events = await readEvents()
    expect((await takeTask(actor, await readTask(), { setDoing: false })).row)
      .toMatchObject({ renewed: true, status: 'in-review' })
    expect(await readEvents()).toEqual(events)
  })

  it.each(['released', 'stolen', 'closed', 'handed-off'])(
    'refuses when the claim is %s between the refused RPC and conditional renewal', async (change) => {
      const before = await readTask()
      const database = pool()
      const query = database.query.bind(database)
      // Keep the real RPC and renewal SQL, injecting the competing mutation
      // immediately after the refused RPC returns. The snapshot still says ours.
      const intercepted = vi.spyOn(database, 'query').mockImplementationOnce((async (...args: Parameters<typeof query>) => {
        const result = await query(...args)
        if (change === 'released') {
          await query('select release_task_atomic($1,$2,$3,$4,$5,$4)',
            [taskId, ownerId, 'agent', actor.actorId, before.ownership_version])
        } else if (change === 'stolen') {
          await query('update tasks set claimed_by = $2, claimed_session = $3, ownership_version = ownership_version + 1 where id = $1',
            [taskId, 'codex · Other', 'session-b'])
        } else if (change === 'closed') {
          await query("update tasks set status = 'cancelled' where id = $1", [taskId])
        } else {
          await query("update tasks set handoff_ref = 'EXT-1', handoff_tracker = 'linear', handoff_status = 'doing' where id = $1", [taskId])
        }
        return result
      }) as typeof database.query)
      try {
        expect(await takeTask(actor, before)).toEqual({ row: null, error: null })
      } finally {
        intercepted.mockRestore()
      }
      expect((await readEvents()).filter((event) => event.event === 'claimed')).toHaveLength(1)
    },
  )
})
