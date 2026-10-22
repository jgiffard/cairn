import { describe, expect, it } from 'vitest'
import { groupRuns, type RunActivity } from './runs'

const row = (day: number, event: string, run?: object, data = {}): RunActivity => ({
  event, data: { ...data, ...(run ? { run } : {}) }, created_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
})

describe('groupRuns', () => {
  it('groups tagged evidence, orders runs, dedupes commits, detects PRs and uses latest link state', () => {
    const rows = [
      row(1, 'run_link', { id: 'r1', state: 'up', seat: 'a', runner: 'drove', url: 'https://x/r1' }),
      row(2, 'git_commit', { id: 'r1', seats: ['a', 'b'], state: 'ignored' }, { sha: 'abcdef1', url: 'https://github.test/p/pull/12' }),
      row(3, 'git_push', { id: 'r1' }, { sha: 'abcdef1', branch: 'main', url: 'https://gitlab.test/p/merge_requests/3' }),
      row(4, 'run_result', { id: 'r1' }, { command: 'npm test', status: 'passed' }),
      row(5, 'run_link', { id: 'r1', state: 'merged', seat: 'c' }),
      row(6, 'git_commit', { id: 'r2' }, { sha: '1234567', url: 'https://x/commit/1' }),
      row(7, 'run_result', undefined, { command: 'ignored', status: 'failed' }),
    ]
    const runs = groupRuns(rows.reverse())
    expect(runs.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(runs[0]).toMatchObject({ state: null, prs: [] })
    expect(runs[1]).toEqual({
      id: 'r1', runner: 'drove', url: 'https://x/r1', state: 'merged', seats: ['a', 'b', 'c'],
      commits: [{ sha: 'abcdef1', repo: null, branch: 'main', url: 'https://gitlab.test/p/merge_requests/3', at: row(3, '').created_at }],
      prs: ['https://gitlab.test/p/merge_requests/3', 'https://github.test/p/pull/12'],
      checks: [{ command: 'npm test', status: 'passed', at: row(4, '').created_at }],
      firstAt: row(1, '').created_at, lastAt: row(5, '').created_at,
    })
  })
})
