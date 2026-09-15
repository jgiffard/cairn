import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const cli = join(process.cwd(), 'cli', 'cairn.mjs')

const run = (home: string, base: string, args: string[], key = 'crn_integration_key') =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CAIRN_AGENT: 'integration-agent',
        CAIRN_API_KEY: key,
        CAIRN_BASE_URL: base,
        CAIRN_DEADLINE_MS: '1',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

describe('durable CLI outbox', () => {
  let home: string
  let server: Server
  let base: string
  let mode: 'fail' | 'success' = 'fail'
  const received: { id: string | undefined; body: string }[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cairn-outbox-'))
    received.length = 0
    mode = 'fail'
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        if (mode === 'fail') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'offline' }))
          return
        }
        received.push({ id: req.headers['idempotency-key'] as string | undefined, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { id: received.length } }))
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

  it('preserves concurrent appends and replays each mutation with a stable unique key', async () => {
    const queued = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        run(home, base, ['comment', 'CAIRN-163', `queued-${index}`]),
      ),
    )
    expect(queued.every((result) => result.code === 0 && result.stderr.includes('queued locally'))).toBe(true)

    const lines = (await readFile(join(home, '.cairn', 'outbox.jsonl'), 'utf8')).trim().split('\n')
    const records = lines.map((line) => JSON.parse(line))
    expect(records).toHaveLength(12)
    expect(new Set(records.map((record) => record.id)).size).toBe(12)
    expect(records.every((record) => record.base === base && record.agent === 'integration-agent')).toBe(true)

    mode = 'success'
    const replay = await run(home, base, ['replay'])
    expect(replay.code).toBe(0)
    expect(replay.stdout).toContain('sent 12, rejected 0, still queued 0')
    expect(received).toHaveLength(12)
    expect(new Set(received.map((request) => request.id)).size).toBe(12)
  })

  it('quarantines records when the runtime key identity changes', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'bound to old key'], 'crn_key_a')
    mode = 'success'
    const replay = await run(home, base, ['replay'], 'crn_key_b')
    expect(replay.stdout).toContain('sent 0, rejected 1, still queued 0')
    expect(received).toHaveLength(0)
    const rejected = await readFile(join(home, '.cairn', 'outbox.jsonl.rejected'), 'utf8')
    expect(rejected).toContain('replay context mismatch')
  })
})
