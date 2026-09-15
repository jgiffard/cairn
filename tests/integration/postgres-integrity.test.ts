import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { createKnowledge, updateKnowledge } from '@/lib/api/knowledge'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()

beforeAll(async () => {
  await pool().query(
    `insert into app_users (id, email, encrypted_password) values ($1,$2,$3)`,
    [ownerId, `integrity-${ownerId}@example.test`, 'not-used'],
  )
  await pool().query(
    `insert into projects (id, owner_user_id, key, title) values ($1,$2,'INT','Integrity')`,
    [projectId, ownerId],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
     values ($1,$2,1,'Concurrency target','agent','integration-agent','todo')`,
    [taskId, projectId],
  )
})

afterAll(async () => {
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('ownership generations and checkpoint ordering', () => {
  it('prevents a stale owner generation from releasing or checkpointing a reclaimed task', async () => {
    const first = await pool().query(
      `select claim_task_atomic($1,$2,'agent','integration-agent','integration-agent',$3,true) as row`,
      [taskId, ownerId, new Date(Date.now() - 60_000)],
    )
    const version1 = Number(first.rows[0].row.ownership_version)
    expect(version1).toBe(1)

    const released = await pool().query(
      `select release_task_atomic($1,$2,'agent','integration-agent',$3,'integration-agent') as row`,
      [taskId, ownerId, version1],
    )
    expect(released.rows[0].row.claimed_by).toBeNull()

    const second = await pool().query(
      `select claim_task_atomic($1,$2,'agent','integration-agent','integration-agent',$3,true) as row`,
      [taskId, ownerId, new Date(Date.now() - 60_000)],
    )
    const version2 = Number(second.rows[0].row.ownership_version)
    expect(version2).toBe(2)

    const staleRelease = await pool().query(
      `select release_task_atomic($1,$2,'agent','integration-agent',$3,'integration-agent') as row`,
      [taskId, ownerId, version1],
    )
    expect(staleRelease.rows[0].row).toBeNull()

    const staleCheckpoint = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'stale', randomUUID(), new Date(), version1, 0],
    )
    expect(staleCheckpoint.rows[0].row.code).toBe('ownership_changed')

    const acceptedAt = new Date()
    const mutationId = randomUUID()
    const accepted = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'current', mutationId, acceptedAt, version2, 0],
    )
    expect(accepted.rows[0].row.code).toBe('ok')
    const duplicate = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'current', mutationId, acceptedAt, version2, 0],
    )
    expect(duplicate.rows[0].row.code).toBe('duplicate')

    const outOfOrder = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'out of sequence', randomUUID(), new Date(acceptedAt.getTime() + 1_000), version2, 0],
    )
    expect(outOfOrder.rows[0].row.code).toBe('checkpoint_changed')
    const nextInSequence = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'next despite skewed clock', randomUUID(), new Date(acceptedAt.getTime() - 60_000), version2, 1],
    )
    expect(nextInSequence.rows[0].row.code).toBe('ok')
    const current = await pool().query('select checkpoint_summary, claimed_by from tasks where id = $1', [taskId])
    expect(current.rows[0]).toMatchObject({ checkpoint_summary: 'next despite skewed clock', claimed_by: 'integration-agent' })
  })

  it('makes reconcile lose safely when heartbeat state changes after its snapshot', async () => {
    const before = await pool().query(
      'select ownership_version, heartbeat_at, updated_at from tasks where id = $1', [taskId],
    )
    await pool().query('update tasks set heartbeat_at = now() + interval \'1 second\' where id = $1', [taskId])
    const result = await pool().query(
      `select reconcile_task_atomic($1,$2,'agent','integration-agent','integration-agent',$3,$4,$5,true,'stale','stale-hash') as released`,
      [taskId, ownerId, before.rows[0].ownership_version, before.rows[0].heartbeat_at, before.rows[0].updated_at],
    )
    expect(result.rows[0].released).toBe(false)
  })
})

describe('atomic knowledge writes', () => {
  it('rolls back the knowledge row when relationship insertion fails', async () => {
    await pool().query(`
      create or replace function fail_integrity_link() returns trigger language plpgsql as $$
      begin raise exception 'fault injected'; end $$;
      create trigger fail_integrity_link before insert on knowledge_projects
      for each row execute function fail_integrity_link();
    `)
    try {
      await expect(createKnowledge(
        { userId: ownerId, actorType: 'agent', actorId: 'integration-agent', rateKey: 'test' },
        {
          title: 'Atomic knowledge sentinel',
          body: 'must roll back',
          labels: [],
          projects: ['INT'],
          entities: [],
          verified: false,
        },
      )).rejects.toThrow('fault injected')
      const row = await pool().query(`select id from knowledge where slug = 'atomic-knowledge-sentinel'`)
      expect(row.rowCount).toBe(0)
    } finally {
      await pool().query('drop trigger if exists fail_integrity_link on knowledge_projects')
      await pool().query('drop function if exists fail_integrity_link()')
    }
  })

  it('rolls back body updates when relationship replacement fails', async () => {
    const actor = { userId: ownerId, actorType: 'agent' as const, actorId: 'integration-agent', rateKey: 'test' }
    const created = await createKnowledge(actor, {
      title: 'Atomic update sentinel',
      body: 'before',
      labels: [],
      projects: [],
      entities: [],
      verified: false,
    })
    if (!created) throw new Error('knowledge creation returned no row')
    await pool().query(`
      create or replace function fail_integrity_link() returns trigger language plpgsql as $$
      begin raise exception 'fault injected'; end $$;
      create trigger fail_integrity_link before insert on knowledge_projects
      for each row execute function fail_integrity_link();
    `)
    try {
      await expect(updateKnowledge(actor, created.slug, {
        body: 'after',
        projects: ['INT'],
      })).rejects.toThrow('fault injected')
      const row = await pool().query('select body from knowledge where id = $1', [created.id])
      expect(row.rows[0].body).toBe('before')
    } finally {
      await pool().query('drop trigger if exists fail_integrity_link on knowledge_projects')
      await pool().query('drop function if exists fail_integrity_link()')
      await pool().query('delete from knowledge where id = $1', [created.id])
    }
  })
})

describe('N-1 migration compatibility', () => {
  it('upgrades an existing pre-043 database without breaking old writes', async () => {
    const adminUrl = new URL(databaseUrl)
    const dbName = `cairn_n1_${randomUUID().replaceAll('-', '')}`
    const admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`create database "${dbName}"`)
    const testUrl = new URL(databaseUrl)
    testUrl.pathname = `/${dbName}`
    const client = new Client({ connectionString: testUrl.toString() })
    await client.connect()
    try {
      const files = (await readdir(join(process.cwd(), 'migrations'))).filter((name) => name.endsWith('.sql')).sort()
      for (const file of files.filter((name) => name < '043_')) {
        await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
      }
      const user = randomUUID()
      const project = randomUUID()
      const task = randomUUID()
      await client.query('insert into app_users (id,email,encrypted_password) values ($1,$2,$3)', [user, `${user}@test`, 'x'])
      await client.query("insert into projects (id,owner_user_id,key,title) values ($1,$2,'OLD','Old')", [project, user])
      await client.query("insert into tasks (id,project_id,number,title,actor_type,actor_id) values ($1,$2,1,'Old row','agent','old-cli')", [task, project])

      await client.query(await readFile(join(process.cwd(), 'migrations', '043_integrity_boundaries.sql'), 'utf8'))
      const upgraded = await client.query('select ownership_version, checkpoint_version from tasks where id = $1', [task])
      expect(upgraded.rows[0]).toMatchObject({ ownership_version: '0', checkpoint_version: '0' })

      await client.query("update tasks set heartbeat_at = now() where id = $1", [task])
      await client.query("insert into task_comments (task_id,actor_type,actor_id,content) values ($1,'agent','old-cli','still works')", [task])
      expect((await client.query('select count(*)::int as count from task_comments where task_id = $1', [task])).rows[0].count).toBe(1)
    } finally {
      await client.end()
      await admin.query(`drop database "${dbName}"`)
      await admin.end()
    }
  })
})
