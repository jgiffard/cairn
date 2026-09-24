import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

describe('cairn session checkpoint CLI', () => {
  it('sends an ongoing session with all requested fields, without closing or checkpointing held tasks', async () => {
    const received: unknown[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { id: 'one', endedAt: null, checkpointed: [] } }))
    })
    const home = mkdtempSync(join(tmpdir(), 'cairn-session-cli-'))
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      await exec('node', ['cli/cairn.mjs', 'session', 'checkpoint', '--id', 'agent:example',
        '--platform', 'other', '--agent', 'example-agent', '--project', 'DEMO',
        '--cwd', '/work/demo', '--request', 'Feature work',
        '--completed', 'In progress', '--json'], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, CAIRN_API_KEY: 'test-key',
          CAIRN_BASE_URL: `http://127.0.0.1:${address.port}` },
      })
      expect(received).toEqual([{ method: 'POST', path: '/api/v1/sessions', body: {
        externalId: 'agent:example', platformSource: 'other', agentId: 'example-agent',
        project: 'DEMO', cwd: '/work/demo', request: 'Feature work',
        completed: 'In progress', files: [], taskRefs: [], ongoing: true, checkpointHeld: false,
      } }])
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
