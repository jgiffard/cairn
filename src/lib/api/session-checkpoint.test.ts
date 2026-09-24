import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionUpsert } from '@/schemas/session'
import type { Actor } from './auth'

const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  taskWrites: 0,
}))
vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        upsert: (row: Record<string, unknown>) => {
          const key = `${row.platform_source}:${row.external_id}`
          // A closed row must not be reopened by a late checkpoint. This is
          // enforced in PostgreSQL too; the mock models that external boundary.
          const previous = db.rows.get(key)
          if (previous?.ended_at && row.ended_at === null) return {
            select: () => ({ single: async () => ({ data: null, error: { message: 'Session already ended; cannot checkpoint.' } }) }),
          }
          const saved = { ...row, id: previous?.id ?? 'session-1' }
          db.rows.set(key, saved)
          return { select: () => ({ single: async () => ({ data: saved, error: null }) }) }
        },
        update: () => { db.taskWrites += 1; return query },
        in: async () => ({ error: null }),
        then: (resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
      }
      return query
    },
  }),
}))
vi.mock('./project-keys', () => ({ resolveProject: async () => null }))
vi.mock('./files', () => ({ recordFiles: async () => {} }))

import { upsertSession } from './sessions'

const actor = {
  userId: 'user-1', actorId: 'agent-1', userDisplayName: 'Agent',
  actorType: 'agent', role: 'member', rateKey: 'agent-1', sessionId: 'agent:example',
} satisfies Actor
const input = (additional: Record<string, unknown> = {}) => sessionUpsert.parse({
  externalId: 'agent:example', platformSource: 'other', agentId: 'example-agent',
  request: 'Feature work', completed: 'Work in progress', ...additional,
})

describe('ongoing session checkpoint', () => {
  beforeEach(() => { db.rows.clear(); db.taskWrites = 0 })

  it('keeps one ongoing row with no end timestamp and never checkpoints held tasks', async () => {
    const first = await upsertSession(actor, input({ ongoing: true }))
    const second = await upsertSession(actor, input({ ongoing: true, completed: 'Updated progress' }))
    expect(first.session.id).toBe(second.session.id)
    expect(db.rows.size).toBe(1)
    expect(first.session.ended_at).toBeNull()
    expect(second.session.completed).toBe('Updated progress')
    expect(second.checkpointed).toEqual([])
    expect(db.taskWrites).toBe(0)
  })

  it('ends that same row through the existing end contract', async () => {
    await upsertSession(actor, input({ ongoing: true }))
    const ended = await upsertSession(actor, input({ checkpointHeld: false }))
    expect(ended.session.id).toBe('session-1')
    expect(ended.session.ended_at).not.toBeNull()
    expect(db.rows.size).toBe(1)
    expect(db.taskWrites).toBe(0)
  })

  it('refuses a late checkpoint on a closed session without reopening it', async () => {
    await upsertSession(actor, input({ checkpointHeld: false }))
    await expect(upsertSession(actor, input({ ongoing: true }))).rejects.toThrow('already ended')
    expect(db.rows.get('other:agent:example')?.ended_at).not.toBeNull()
  })

  it('rejects contradictory ongoing payloads at the API schema boundary', () => {
    expect(sessionUpsert.safeParse({ externalId: 'x', ongoing: true, endedAt: '2026-09-23T00:00:00Z' }).success).toBe(false)
    expect(sessionUpsert.safeParse({ externalId: 'x', ongoing: true, checkpointHeld: true }).success).toBe(false)
  })
})
