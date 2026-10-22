import { pool, normalizeDatabaseValue } from '@/lib/db/client'
import type { z } from 'zod'
import type { evidenceRunSchema } from '@/schemas/task'

/** Serialize run-link retries per task/run, including concurrent requests. */
export const recordRunLink = async (
  taskId: string,
  actor: { userId: string; actorType: string; actorId: string },
  data: { run: z.infer<typeof evidenceRunSchema> } & Record<string, unknown>,
) => {
  const client = await pool().connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([taskId, data.run.id])])
    const previous = await client.query(
      "select id, event, data, actor_type, actor_id, created_at from task_activity_events where task_id = $1 and event = 'run_link' and data->'run'->>'id' = $2 order by created_at desc, id desc limit 1",
      [taskId, data.run.id],
    )
    const prior = previous.rows[0]
    // JSON field order is immaterial. A seat is included so changing its
    // attribution is retained, as well as changes to the run's other fields.
    const same = prior && ['id', 'state', 'url', 'seats', 'runner', 'seat'].every(
      (key) => JSON.stringify(prior.data.run[key] ?? null) === JSON.stringify(data.run[key as keyof typeof data.run] ?? null),
    )
    const row = same ? prior : (await client.query(
      "insert into task_activity_events (owner_user_id, task_id, actor_type, actor_id, event, data, created_at) values ($1, $2, $3, $4, 'run_link', $5::jsonb, clock_timestamp()) returning id, event, data, actor_type, actor_id, created_at",
      [actor.userId, taskId, actor.actorType, actor.actorId, JSON.stringify(data)],
    )).rows[0]
    await client.query('commit')
    return { row: normalizeDatabaseValue(row), duplicate: Boolean(same) }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
