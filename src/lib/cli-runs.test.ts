import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method?: string; path?: string; body?: Record<string, unknown> }
type Routes = Record<string, unknown>

/** `METHOD /path` → data. Anything not listed answers 404, which fails the verb loudly. */
const serve = (routes: Routes, seen: Seen[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method, path: req.url }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        const key = `${req.method} ${req.url}`
        const found = key in routes
        if ((routes[key] as { rejection?: boolean })?.rejection) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'event must be git_commit, git_push or run_result; run_link refused', code: 'validation_error' }))
          return
        }
        res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(found ? { success: true, data: routes[key] } : { success: false, error: `no route ${key}`, code: 'not_found' }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string, stdin?: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-coverage-'))
  directories.push(home)
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', ...args], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key', CAIRN_AGENT: 'test' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

describe('CLI run evidence', () => {
  it('posts run-link with repeated seats and tags commit push and run', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'POST /api/v1/tasks/CAIRN-1/activity': { id: 'e1' } }, seen)
    const link = await run(['run-link', 'CAIRN-1', 'r1', '--runner', 'drove', '--state', 'up', '--url', 'https://x.test/r1', '--seat', 'w-a', '--seat', 'w-b', '--json'], base)
    expect(link.code, link.stderr).toBe(0)
    expect(writes(seen)[0]?.body).toEqual({ event: 'run_link', run: { id: 'r1', runner: 'drove', state: 'up', url: 'https://x.test/r1', seats: ['w-a', 'w-b'] } })
    for (const args of [['commit', 'CAIRN-1', 'abcdef1'], ['push', 'CAIRN-1', 'abcdef1'], ['run', 'CAIRN-1', 'npm test', '--status', 'passed']]) {
      const result = await run([...args, '--run', 'r1', '--runner', 'drove', '--run-url', 'https://x.test/r1', '--seat', 'w-a'], base)
      expect(result.code, result.stderr).toBe(0)
      expect(writes(seen).at(-1)?.body?.run).toEqual({ id: 'r1', runner: 'drove', url: 'https://x.test/r1', seats: ['w-a'] })
    }
  })
  it('prints grouped runs as JSON', async () => {
    const seen: Seen[] = []
    const runs = [{ id: 'r1', state: 'up', seats: [] }]
    const base = await serve({ 'GET /api/v1/tasks/CAIRN-1/runs': runs }, seen)
    const result = await run(['runs', 'CAIRN-1', '--json'], base)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(runs)
  })
})
function writes(seen: Seen[]) { return seen.filter((s) => s.method !== 'GET') }

it('explains an older server rejecting run_link', async () => {
  const seen: Seen[] = []
  const base = await serve({ 'POST /api/v1/tasks/CAIRN-1/activity': { rejection: true } }, seen)
  const result = await run(['run-link', 'CAIRN-1', 'r1'], base)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('This server does not support run_link')
})
