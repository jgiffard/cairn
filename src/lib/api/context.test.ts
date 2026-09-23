import { describe, expect, it, vi } from 'vitest'
import type { Actor } from './auth'

const records = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  sessions: [] as Record<string, unknown>[],
  calls: [] as { table: string; filters: [string, unknown][]; limit: number | null }[],
}))

// In-memory query boundary: filters are applied before ordering/limit, as in SQL.
vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = []
      let limit: number | null = null
      let order: { column: string; ascending: boolean } | null = null
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return query },
        in: (column: string, value: unknown) => { filters.push([column, value]); return query },
        not: () => query,
        lt: () => query,
        order: (column: string, options?: { ascending?: boolean }) => {
          order = { column, ascending: options?.ascending !== false }
          return query
        },
        limit: (value: number) => { limit = value; return query },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows(), error: null })),
      }
      function rows(): Record<string, unknown>[] {
        records.calls.push({ table, filters: [...filters], limit })
        let result = (table === 'tasks' ? records.tasks : table === 'sessions' ? records.sessions : [])
          .filter((row) => filters.every(([column, value]) => {
            const actual = column === 'projects.key' ? (row.project as { key: string } | undefined)?.key : row[column]
            return Array.isArray(value) ? value.includes(actual) : actual === value
          }))
        if (order) {
          const { column, ascending } = order
          result = [...result].sort((a, b) =>
            (String(a[column] ?? '') < String(b[column] ?? '') ? -1 : String(a[column] ?? '') > String(b[column] ?? '') ? 1 : 0) * (ascending ? 1 : -1))
        }
        return limit === null ? result : result.slice(0, limit)
      }
      return query
    },
  }),
}))
vi.mock('./project-keys', () => ({
  liveProjectKey: async (key: string) => ({ key: key === 'OLD' ? 'MES' : key, renamed: null }),
  formerKeysByProject: async () => new Map(),
  formerRefsOf: () => [],
}))
vi.mock('./knowledge', () => ({ listKnowledge: async () => [] }))
vi.mock('./staleness', () => ({ stalenessFor: async () => new Map() }))

import { buildContext } from './context'

const actor = { userId: 'user', actorId: 'agent', actorType: 'agent', role: 'member', rateKey: 'agent', userDisplayName: 'Agent', sessionId: null } satisfies Actor
const task = (project: string, number: number, claimedAt: string) => ({
  id: `${project}-${number}`, number, project_id: project, project: { key: project }, title: `${project} work`,
  status: 'doing', claimed_by: 'agent', claimed_at: claimedAt, created_at: claimedAt,
  heartbeat_at: null, updated_at: claimedAt,
})
const session = (project: string, cwd: string, endedAt: string) => ({
  project_id: project, project: { key: project }, cwd, ended_at: endedAt,
  request: `${project} request`, next_steps: null, agent_id: 'agent',
})

describe('classified briefing isolation', () => {
  it('returns held tasks of the classified project even beyond ten foreign claims', async () => {
    records.calls = []
    records.sessions = []
    records.tasks = [
      ...Array.from({ length: 10 }, (_, i) => task('CAL', i + 1, `2026-09-01T00:${String(i).padStart(2, '0')}:00Z`)),
      task('MES', 11, '2026-09-02T00:00:00Z'),
    ]
    const context = await buildContext(actor, { project: 'MES' })
    expect(context.held.map((held) => held.ref)).toEqual(['MES-11'])
    expect(records.calls.find((call) => call.table === 'tasks' && call.filters.some(([key]) => key === 'claimed_by')))
      .toMatchObject({ filters: [['claimed_by', 'agent'], ['projects.key', 'MES']], limit: 10 })
  })

  it('returns the most recent session of the classified project, not a newer foreign session in the same cwd', async () => {
    records.calls = []
    records.tasks = []
    records.sessions = [
      session('MES', '/repo', '2026-09-01T00:00:00Z'),
      session('CAL', '/repo', '2026-09-02T00:00:00Z'),
    ]
    const context = await buildContext(actor, { project: 'MES', cwd: '/repo' })
    expect(context.lastSession?.request).toBe('MES request')
    expect(records.calls.find((call) => call.table === 'sessions'))
      .toMatchObject({ filters: [['cwd', '/repo'], ['projects.key', 'MES']], limit: 1 })
  })

  it('uses the live project for a former key even without cwd', async () => {
    records.calls = []
    records.tasks = [task('CAL', 1, '2026-09-01T00:00:00Z'), task('MES', 2, '2026-09-02T00:00:00Z')]
    records.sessions = [
      session('MES', '/mes', '2026-09-01T00:00:00Z'),
      session('CAL', '/cal', '2026-09-02T00:00:00Z'),
    ]
    const context = await buildContext(actor, { project: 'OLD' })
    expect(context.project).toBe('MES')
    expect(context.held.map((held) => held.ref)).toEqual(['MES-2'])
    expect(context.lastSession?.request).toBe('MES request')
  })

  it('keeps cwd-only project classification for held and last session', async () => {
    records.calls = []
    records.tasks = [task('CAL', 1, '2026-09-01T00:00:00Z'), task('MES', 2, '2026-09-02T00:00:00Z')]
    records.sessions = [session('CAL', '/repo', '2026-09-03T00:00:00Z')]
    const context = await buildContext(actor, { cwd: '/repo' })
    expect(context.held.map((held) => held.ref)).toEqual(['CAL-1'])
    expect(context.lastSession?.request).toBe('CAL request')
  })

  it('keeps all held claims when there is no classified project', async () => {
    records.calls = []
    records.tasks = [task('CAL', 1, '2026-09-01T00:00:00Z'), task('MES', 2, '2026-09-02T00:00:00Z')]
    records.sessions = []
    const context = await buildContext(actor, {})
    expect(context.project).toBeNull()
    expect(context.held.map((held) => held.ref)).toEqual(['CAL-1', 'MES-2'])
    expect(context.lastSession).toBeNull()
    expect(records.calls.some((call) => call.table === 'sessions')).toBe(false)
  })
})
