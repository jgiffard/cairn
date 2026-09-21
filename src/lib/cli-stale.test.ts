import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * A stale CLI used to confess only to `cairn --version`, which is the one
 * command an agent has no reason to run. Every response now carries the
 * version that served it, so an ordinary call says so.
 *
 * Spawned against a fake server rather than asserted from source, because the
 * thing worth testing is what an agent sees on stdout and stderr.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const serve = (version: string | null) =>
  new Promise<string>((resolve) => {
    const server = createServer((_req, res) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (version) headers['x-cairn-version'] = version
      res.writeHead(200, headers)
      res.end(JSON.stringify({ success: true, data: [] }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const runCli = async (base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-stale-'))
  directories.push(home)
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/cairn.mjs', 'projects'], {
      env: { ...process.env, HOME: home, CAIRN_BASE_URL: base, CAIRN_API_KEY: 'test-key' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', () => resolve({ stdout, stderr }))
  })
}

describe('a stale CLI on the ordinary path', () => {
  it('says so on stderr when the server reports a different version', async () => {
    const { stdout, stderr } = await runCli(await serve('9.9.9'))
    expect(stderr).toContain('9.9.9')
    expect(stderr).toMatch(/this CLI is \d+\.\d+\.\d+/)
    // stdout is parsed by callers; a warning in it would be the bug.
    expect(stdout).not.toContain('9.9.9')
  })

  it('stays quiet when the versions agree', async () => {
    const { version } = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8')),
    )
    const { stderr } = await runCli(await serve(version))
    expect(stderr).not.toContain('run scripts/sync-agent-files.mjs')
  })

  it('stays quiet when the server sends no version at all', async () => {
    const { stderr } = await runCli(await serve(null))
    expect(stderr).not.toContain('run scripts/sync-agent-files.mjs')
  })
})
