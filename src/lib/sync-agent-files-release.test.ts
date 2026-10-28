import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('writes nothing and never falls back to main when the reported release tag is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-sync-absent-tag-'))
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/api/v1/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { version: '0.25.2' } }))
    } else {
      res.writeHead(404)
      res.end('tag not published')
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await mkdir(join(home, '.cairn/maintenance'), { recursive: true })
    await mkdir(join(home, '.local/bin'), { recursive: true })
    await writeFile(join(home, '.cairn/env'), `CAIRN_BASE_URL=${base}\n`)
    await writeFile(join(home, '.local/bin/cairn'), 'installed CLI')
    await writeFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), 'installed sync')
    const snapshot = async () => {
      const entries = (await readdir(home, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
      return Promise.all(entries.map(async (entry) => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), 'utf8')]))
    }
    const before = await snapshot()
    const result = await promisify(execFile)(process.execPath, [
      'scripts/sync-agent-files.mjs', '--source', 'release', '--repo', `${base}/raw`,
    ], { env: { HOME: home, PATH: process.env.PATH, NODE_ENV: 'test', TMPDIR: tmpdir(), CAIRN_SYNC_RETRY_MS: '0' } })
      .then((value) => ({ ...value, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('NOT SYNCED:')
    expect(result.stdout).toContain('returned 404')
    expect(result.stdout).toContain('Nothing was written')
    expect(await snapshot()).toEqual(before)
    expect(requests[0]).toBe('/api/v1/health')
    expect(requests.slice(1).length).toBeGreaterThan(0)
    expect(requests.slice(1).every((path) => path.startsWith('/raw/v0.25.2/'))).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
