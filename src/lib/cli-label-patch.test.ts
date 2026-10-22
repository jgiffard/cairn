import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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

const task = { ref: 'CIVIC-1', title: 'T', status: 'todo' }
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== 'GET')

describe('CLI atomic label updates', () => {
  it('sends repeated and comma-separated add/remove flags with other fields and returns JSON', async () => {
    const seen: Seen[] = []
    const result = { ...task, labels: ['b', 'c', 'd'], labelPatch: { added: ['c', 'd'], removed: ['a'], alreadyPresent: ['b'], alreadyAbsent: [] } }
    const base = await serve({ 'PATCH /api/v1/tasks/CIVIC-1': result }, seen)
    const output = await run(['update', 'CIVIC-1', '--add-label', 'b,c', '--add-label', ' d ', '--remove-label', 'a', '--title', 'Changed', '--json'], base)
    expect(output.code).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual(result)
    expect(writes(seen).map((s) => s.body)).toEqual([{ title: 'Changed', labelPatch: { add: ['b', 'c', 'd'], remove: ['a'] } }])
    expect(output.stderr).not.toContain('does not take')
  })

  it('reports additions removals and already present or absent labels to humans', async () => {
    const seen: Seen[] = []
    const base = await serve({ 'PATCH /api/v1/tasks/CIVIC-1': { ...task, labels: ['b', 'c'], labelPatch: { added: ['c'], removed: ['a'], alreadyPresent: ['b'], alreadyAbsent: ['z'] } } }, seen)
    const output = await run(['update', 'CIVIC-1', '--add-label', 'b,c', '--remove-label', 'a,z'], base)
    expect(output.code).toBe(0)
    expect(output.stdout).toContain('CIVIC-1 labels: b, c (added c; removed a; already had b; already absent z)')
  })

  it('reports a retry as already present and succeeds', async () => {
    const seen: Seen[] = []
    const route = 'PATCH /api/v1/tasks/CIVIC-1'
    const routes: Routes = { [route]: { ...task, labels: ['a', 'x'], labelPatch: { added: ['x'], removed: [], alreadyPresent: [], alreadyAbsent: [] } } }
    const base = await serve(routes, seen)
    expect((await run(['update', 'CIVIC-1', '--add-label', 'x'], base)).stdout).toContain('added x')
    routes[route] = { ...task, labels: ['a', 'x'], labelPatch: { added: [], removed: [], alreadyPresent: ['x'], alreadyAbsent: [] } }
    const retry = await run(['update', 'CIVIC-1', '--add-label', 'x'], base)
    expect(retry.code).toBe(0)
    expect(retry.stdout).toContain('already had x')
  })

  it.each(['add-label', 'remove-label'])('refuses --label combined with --%s before any request', async (flag) => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const output = await run(['update', 'CIVIC-1', '--label', 'a', `--${flag}`, 'b'], base)
    expect(output.code).not.toBe(0)
    expect(output.stderr).toContain('--label cannot be combined with --add-label or --remove-label')
    expect(seen).toEqual([])
  })

  it.each(['add-label', 'remove-label'].flatMap((flag) => [
    [[`--${flag}`, ''], `--${flag} needs a value`],
    [[`--${flag}`], `--${flag} needs a value`],
    [[`--${flag}= `], `--${flag} needs a value`],
    [[`--${flag}`, ', ,'], `--${flag} needs a value`],
    [[`--${flag}`, 'none'], '--label none clears all labels'],
    [[`--${flag}`, 'a,none'], '--label none clears all labels'],
    [[`--${flag}`, 'x'.repeat(51)], '1..50 characters'],
    [[`--${flag}`, 'a', `--${flag}`, ''], `--${flag} needs a value`],
  ] as const))('refuses malformed delta %j before any request', async (args, message) => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const output = await run(['update', 'CIVIC-1', ...args], base)
    expect(output.code).not.toBe(0)
    expect(output.stderr).toContain(message)
    expect(seen).toEqual([])
  })

  it('refuses overlapping add and remove before any request', async () => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const output = await run(['update', 'CIVIC-1', '--add-label', 'a', '--remove-label', 'a'], base)
    expect(output.code).not.toBe(0)
    expect(output.stderr).toContain('both --add-label and --remove-label')
    expect(seen).toEqual([])
  })

  it.each(['add', 'list', 'show', 'note', 'relearn', 'help'].flatMap((verb) => ['add-label', 'remove-label'].map((flag) => [verb, flag])))('refuses %s --%s before any request', async (verb, flag) => {
    const seen: Seen[] = []
    const base = await serve({}, seen)
    const output = await run([verb, 'CIVIC-1', `--${flag}`, 'a'], base)
    expect(output.code).toBe(2)
    expect(output.stderr).toContain(`does not take --${flag}`)
    expect(seen).toEqual([])
  })

  it('documents both flags in general and update help and skill files within budget', async () => {
    const base = await serve({}, [])
    for (const args of [['--help'], ['update', '--help']]) {
      const output = await run(args, base)
      expect(output.code).toBe(0)
      const line = output.stdout.split('\n').find((line) => line.includes('cairn update <ref> --add-label'))
      expect(line).toContain('--remove-label')
    }
    for (const path of ['skills/cairn/SKILL.md', 'skills/cairn/reference.md']) {
      const doc = await readFile(path, 'utf8')
      expect(doc).toContain('--add-label')
      expect(doc).toContain('--remove-label')
      if (path.endsWith('SKILL.md')) expect(Buffer.byteLength(doc)).toBeLessThanOrEqual(8000)
    }
  })
})
