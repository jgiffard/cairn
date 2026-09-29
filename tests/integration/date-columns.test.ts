import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, pool } from '@/lib/db/client'

/**
 * A due date reads back as the day it was set. It came back as an ISO
 * timestamp at local midnight — a day early east of UTC, and a value no date
 * input can show — so the task page saved a due date and then drew it blank.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `dates-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,'DATE','Dates')`, [
    projectId,
    ownerId,
  ])
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_id, due_date) values ($1,$2,1,'due','t','2026-10-15')`,
    [taskId, projectId],
  )
})

afterAll(async () => {
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
})

describe('date columns', () => {
  it('read back as the calendar day, through the adapter and the pool alike', async () => {
    const { data } = await admin().from('tasks').select('due_date').eq('id', taskId).single()
    expect(data?.due_date).toBe('2026-10-15')
    const { rows } = await pool().query('select due_date from tasks where id = $1', [taskId])
    expect(rows[0].due_date).toBe('2026-10-15')
  })

  it('leave timestamps as ISO strings', async () => {
    const { data } = await admin().from('tasks').select('created_at').eq('id', taskId).single()
    expect(data?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })
})
