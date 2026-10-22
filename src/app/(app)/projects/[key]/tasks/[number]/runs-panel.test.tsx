import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskRun } from '@/lib/runs'
import { RunsPanel } from './runs-panel'

const run = (over: Partial<TaskRun> = {}): TaskRun => ({
  id: 'run-1',
  runner: 'drove',
  url: 'https://drove.example.test/runs/run-1',
  state: 'running',
  seats: ['w-a', 'w-b'],
  commits: [
    {
      sha: 'abcdef1234567890',
      repo: '/Users/cal/maestro-dev/cairn',
      branch: 'feat/runs',
      url: 'https://github.com/o/r/commit/abcdef1',
      at: '2026-10-22T10:00:00.000Z',
    },
  ],
  prs: ['https://github.com/o/r/pull/156'],
  checks: [{ command: 'npm test', status: 'passed', at: '2026-10-22T10:05:00.000Z' }],
  firstAt: '2026-10-22T09:00:00.000Z',
  lastAt: '2026-10-22T10:05:00.000Z',
  ...over,
})

const render = (runs: TaskRun[]) => renderToStaticMarkup(<RunsPanel runs={runs} />)

describe('RunsPanel', () => {
  it('renders nothing when there are no runs', () => {
    expect(render([])).toBe('')
  })

  it("renders a run's fields in the order given", () => {
    const html = render([run(), run({ id: 'run-0', url: null, state: null, commits: [], prs: [], checks: [] })])
    expect(html).toContain('<h2')
    expect(html).toContain('Runs')
    expect(html.indexOf('run-1')).toBeLessThan(html.indexOf('run-0'))
    expect(html).toContain('title="run-1"')
    expect(html).toContain('drove')
    expect(html).toContain('running')
    expect(html).toContain('w-a, w-b')
    expect(html).toContain('abcdef1<')
    expect(html).not.toContain('abcdef12')
    expect(html).toContain('feat/runs')
    expect(html).toContain('>#156<')
    expect(html).toContain('npm test')
    expect(html).toContain('passed')
  })

  it('links the run id to an http(s) url in a new tab', () => {
    const html = render([run()])
    expect(html).toMatch(
      /<a href="https:\/\/drove\.example\.test\/runs\/run-1" target="_blank" rel="noopener noreferrer"/,
    )
  })

  it('emits no href for a javascript: url', () => {
    const html = render([
      run({
        url: 'javascript:alert(1)',
        prs: ['javascript:alert(2)'],
        commits: [{ sha: 'abcdef1234', repo: 'r', branch: 'b', url: 'javascript:alert(3)', at: '2026-10-22T10:00:00.000Z' }],
      }),
    ])
    expect(html).not.toContain('href=')
    expect(html).not.toContain('javascript:')
  })

  it('shows only the last segment of a local repo path', () => {
    const html = render([run()])
    expect(html).toContain('>cairn<')
    expect(html).not.toContain('maestro-dev')
  })
})
