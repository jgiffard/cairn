import { describe, expect, it } from 'vitest'
import { createActivityEvidenceSchema } from './task'

describe('run evidence schema', () => {
  it('preserves run fields on every evidence event', () => {
    const run = { id: 'r1', runner: 'drove', url: 'https://x.test/runs/r1', state: 'up', seat: 'a', seats: ['b'] }
    for (const event of ['git_commit', 'git_push', 'run_result', 'run_link']) {
      expect(createActivityEvidenceSchema.parse({ event, sha: 'abcdef1', command: 'test', status: 'passed', run }).run).toEqual(run)
    }
  })
  it('requires run.id for run_link', () => {
    for (const run of [undefined, {}]) {
      const parsed = createActivityEvidenceSchema.safeParse({ event: 'run_link', run })
      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.issues.some((i) => i.path.join('.') === 'run.id')).toBe(true)
    }
  })
  it.each(['javascript:alert(1)', 'data:text/html,x'])('refuses unsafe evidence and run URLs %s', (url) => {
    expect(createActivityEvidenceSchema.safeParse({ event: 'git_commit', sha: 'abcdef1', url }).success).toBe(false)
    expect(createActivityEvidenceSchema.safeParse({ event: 'run_link', run: { id: 'r1', url } }).success).toBe(false)
  })
  it.each(['x'.repeat(121), 'has space', 'has/slash', ''])('refuses invalid run id %s', (id) => {
    expect(createActivityEvidenceSchema.safeParse({ event: 'run_link', run: { id } }).success).toBe(false)
  })
  it('enforces runner state and seat bounds', () => {
    for (const extra of [{ runner: 'UP' }, { state: 'bad state' }, { seat: 'x'.repeat(65) }, { seats: Array(51).fill('a') }]) {
      expect(createActivityEvidenceSchema.safeParse({ event: 'run_link', run: { id: 'r1', ...extra } }).success).toBe(false)
    }
  })
})
