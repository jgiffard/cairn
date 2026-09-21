import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `cairn vitals` is how an agent asks whether the memory is being used. The
 * numbers existed and were rendered only on a web page — the one place the
 * population they measure cannot look. So this asserts what lands in a
 * terminal, and that a missing block does not take the monitor down with it.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const report = (memory: unknown) => ({
  windowHours: 24,
  sessions: { recent: 3, recentWithFiles: 2, baseline: 1, baselineWithFiles: 1 },
  tasks: { opened: 4, closed: 8, stalled: 1, held: 2, closedWithoutTrace: 0 },
  agents: [],
  findings: [],
  autoReleased: 0,
  knowledgeWritten: 2,
  memory,
})

const serve = (body: unknown) =>
  new Promise<string>((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: body }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const vitals = async (body: unknown) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-vitals-'))
  directories.push(home)
  const base = await serve(body)
  return new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', 'vitals', '--all'], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, code }))
  })
}

describe('cairn vitals', () => {
  it('reports whether the memory was consulted, where an agent can read it', async () => {
    const { stdout } = await vitals(
      report({
        windowHours: 24,
        searches: 12,
        widened: 3,
        zeroResults: 2,
        byAgent: [],
        tasksFiled: 5,
        tasksFiledWithoutChecking: 4,
        recentMisses: ['postgres generated columns'],
      }),
    )
    expect(stdout).toContain('memory 12 searches (3 widened, 2 empty)')
    expect(stdout).toContain('4 of 5 tasks filed without checking first')
    expect(stdout).toContain('asked for, not held: postgres generated columns')
  })

  it('still answers when the memory aggregate is unreadable', async () => {
    const { stdout, code } = await vitals(report(null))
    expect(code).toBe(0)
    expect(stdout).toContain('knowledge written 2')
    expect(stdout).not.toContain('memory ')
  })
})
