import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const cli = join(process.cwd(), 'cli', 'cairn.mjs')
const KEY = 'crn_integration_key'

const run = (home: string, base: string, args: string[], extraEnv: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CAIRN_AGENT: 'integration-agent',
        CAIRN_API_KEY: KEY,
        CAIRN_BASE_URL: base,
        CAIRN_DEADLINE_MS: '1',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }))
  })

type Limited = { header?: string; retryAfter?: number }

describe('CLI waits out a 429 rate limit', () => {
  let home: string
  let server: Server
  let base: string
  // How many of the next matching requests are answered 429, and how.
  let limit: Limited & { remaining: number } = { remaining: 0 }
  const seen: { method: string; url: string; key: string | undefined }[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cairn-rate-'))
    seen.length = 0
    limit = { remaining: 0 }
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        // Project-key refreshes are hints the CLI may fire on its own: not under test.
        if (req.url === '/api/v1/projects') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: [] }))
          return
        }
        seen.push({ method: req.method ?? '', url: req.url ?? '', key: req.headers['idempotency-key'] as string | undefined })
        if (limit.remaining > 0) {
          limit.remaining -= 1
          const headers: Record<string, string> = { 'content-type': 'application/json' }
          if (limit.header !== undefined) headers['retry-after'] = limit.header
          res.writeHead(429, headers)
          res.end(JSON.stringify({
            success: false,
            code: 'rate_limited',
            error: 'Too many requests. Retry in 1s.',
            ...(limit.retryAfter === undefined ? {} : { retryAfter: limit.retryAfter }),
          }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { id: 1, ownership_version: 1, checkpoint_version: 1 } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  })

  const comment = (extraEnv: Record<string, string> = {}) =>
    run(home, base, ['comment', 'CAIRN-163', 'rate limited'], extraEnv)
  const outboxPath = () => join(home, '.cairn', 'outbox.jsonl')

  it('waits the Retry-After header once, then succeeds and sends the write exactly once more', async () => {
    limit = { remaining: 1, header: '1', retryAfter: 1 }
    const result = await comment()
    expect(result.code).toBe(0)
    expect(result.ms).toBeGreaterThanOrEqual(1000)
    expect(result.ms).toBeLessThan(4000)
    const writes = seen.filter((request) => request.method === 'POST')
    expect(writes).toHaveLength(2)
    expect(existsSync(outboxPath())).toBe(false)
  })

  it('gives up after 4 requests with the server message, a non-zero exit, and nothing queued', async () => {
    limit = { remaining: 99, header: '0', retryAfter: 0 }
    const result = await comment({ CAIRN_RATE_RETRY_MAX_MS: '50' })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Too many requests. Retry in 1s.')
    expect(result.stderr).not.toContain('queued locally')
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(4)
    expect(existsSync(outboxPath())).toBe(false)
  })

  it('caps a huge Retry-After', async () => {
    limit = { remaining: 3, header: '3600' }
    const result = await comment({ CAIRN_RATE_RETRY_MAX_MS: '150' })
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(5000)
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(4)
  })

  it('prefers the Retry-After header over the JSON retryAfter', async () => {
    limit = { remaining: 1, header: '1', retryAfter: 4 }
    const result = await comment()
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(3000)
  })

  it('falls back to the JSON retryAfter without a header', async () => {
    limit = { remaining: 1, retryAfter: 2 }
    const result = await comment()
    expect(result.code).toBe(0)
    expect(result.ms).toBeGreaterThanOrEqual(2000)
    expect(result.ms).toBeLessThan(5000)
  })

  it('waits about a second when the server says nothing', async () => {
    limit = { remaining: 1 }
    const result = await comment()
    expect(result.code).toBe(0)
    expect(result.ms).toBeGreaterThanOrEqual(1000)
    expect(result.ms).toBeLessThan(3500)
  })

  it('retries a read the same way', async () => {
    limit = { remaining: 2, header: '0' }
    const result = await run(home, base, ['show', 'CAIRN-163'], { CAIRN_RATE_RETRY_MAX_MS: '50' })
    const reads = seen.filter((request) => request.method === 'GET' && request.url.includes('CAIRN-163'))
    expect(reads.length).toBeGreaterThanOrEqual(3)
    expect(result.stderr).not.toContain('Too many requests')
  })

  it('keeps a replayed write queued on a 429 and resends it under the same Idempotency-Key', async () => {
    const dir = join(home, '.cairn')
    await mkdir(dir, { recursive: true })
    const item = {
      id: 'rate-limited-item',
      t: '2026-09-28T08:00:00.000Z',
      method: 'POST',
      path: '/api/v1/tasks/rate-limited-item/comments',
      body: { body: 'queued' },
      agent: 'integration-agent',
      base,
      keyId: createHash('sha256').update(KEY).digest('hex').slice(0, 24),
    }
    await writeFile(join(dir, 'outbox.jsonl'), `${JSON.stringify(item)}\n`)

    limit = { remaining: 1, header: '1' }
    const first = await run(home, base, ['replay'])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('sent 0, rejected 0, still queued 1')
    expect(seen).toHaveLength(1)
    expect(existsSync(join(dir, 'outbox.rejected.jsonl'))).toBe(false)
    expect(await readFile(outboxPath(), 'utf8').catch(() => 'moved')).toBeTruthy()

    const second = await run(home, base, ['replay'])
    expect(second.stdout).toContain('sent 1, rejected 0, still queued 0')
    expect(seen.map((request) => request.key)).toEqual(['rate-limited-item', 'rate-limited-item'])
  })
})
