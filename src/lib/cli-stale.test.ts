import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

const serve = (version: string | null, cli?: string | null, builtAt?: string) =>
  new Promise<string>((resolve) => {
    const server = createServer((_req, res) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (version) headers['x-cairn-version'] = version
      if (cli) headers['x-cairn-cli'] = cli
      if (builtAt) headers['x-cairn-built-at'] = builtAt
      res.writeHead(200, headers)
      res.end(JSON.stringify({ success: true, data: [] }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const runCli = async (base: string, script: (home: string) => Promise<string> = async () => 'cli/cairn.mjs') => {
  const home = await mkdtemp(join(tmpdir(), 'cairn-stale-'))
  directories.push(home)
  const file = await script(home)
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', [file, 'projects'], {
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
    expect(stderr).not.toMatch(/than the server|CLI and server differ/)
  })

  it('stays quiet when the server sends no version at all', async () => {
    const { stderr } = await runCli(await serve(null))
    expect(stderr).not.toMatch(/than the server|CLI and server differ/)
  })
})

/**
 * The version check is nearly inert on its own, which is CAIRN-261. Releases
 * are cut by hand and 133 commits fitted inside v0.5.1, so the copy this was
 * found on was two features behind while both sides reported the same number
 * and nothing could fire. The fingerprint is the part that catches that.
 */
describe('a CLI that is the right release and the wrong file', () => {
  const release = () =>
    JSON.parse(readFileSync('package.json', 'utf8')).version as string

  const ownFingerprint = () =>
    createHash('sha256').update(readFileSync('cli/cairn.mjs')).digest('hex').slice(0, 16)

  it('says so when the release agrees and the fingerprint does not', async () => {
    const { stdout, stderr } = await runCli(await serve(release(), '0123456789abcdef'))
    expect(stderr).toContain('0123456789abcdef')
    expect(stderr).toContain('CLI and server differ')
    expect(stdout).not.toContain('0123456789abcdef')
  })

  it('stays quiet when the fingerprint is the file it is running', async () => {
    const { stderr } = await runCli(await serve(release(), ownFingerprint()))
    expect(stderr).not.toMatch(/than the server|CLI and server differ/)
  })

  it('stays quiet when the server offers no fingerprint', async () => {
    const { stderr } = await runCli(await serve(release(), null))
    expect(stderr).not.toMatch(/than the server|CLI and server differ/)
  })

  /**
   * One line, not two. A release mismatch already says everything a
   * fingerprint mismatch would, and the point of warning once per process is
   * that the warning gets read.
   */
  it('reports the release when both differ, and says it once', async () => {
    const { stderr } = await runCli(await serve('9.9.9', '0123456789abcdef'))
    expect(stderr).toContain('9.9.9')
    expect(stderr).not.toContain('0123456789abcdef')
    expect(stderr.match(/older than the server/g)).toHaveLength(1)
  })

  /**
   * The digest has to be the one scripts/sync-agent-files.mjs prints, or the
   * installer's log line and the server's header describe the same file with
   * two different strings and neither can be checked against the other.
   */
  it('uses the same digest the installer reports', async () => {
    const installer = readFileSync('scripts/sync-agent-files.mjs', 'utf8')
    expect(installer).toContain("createHash('sha256').update(buffer).digest('hex').slice(0, 16)")
    expect(ownFingerprint()).toMatch(/^[0-9a-f]{16}$/)
  })
})

/**
 * The agent-files job writes ~/.local/bin/cairn and the managed paths, so its
 * command only helps when that is the file running. HOME is a temp directory,
 * so the managed paths are the ones the test makes.
 */
describe('the command the warning names', () => {
  const release = () => JSON.parse(readFileSync('package.json', 'utf8')).version as string
  const drifted = '0123456789abcdef'

  const managedCopy = async (home: string) => {
    await mkdir(join(home, '.local/bin'), { recursive: true })
    await mkdir(join(home, '.cairn/maintenance'), { recursive: true })
    await writeFile(join(home, '.cairn/maintenance/sync-agent-files.mjs'), '')
    const managed = join(home, '.local/bin/cairn')
    await copyFile('cli/cairn.mjs', managed)
    return managed
  }

  it('says the sync will not touch a file it does not manage, and names one that does', async () => {
    const { stderr, stdout } = await runCli(await serve(release(), drifted), async (home) => {
      await managedCopy(home)
      const elsewhere = join(home, 'my copy/cairn.mjs')
      await mkdir(join(home, 'my copy'), { recursive: true })
      await copyFile('cli/cairn.mjs', elsewhere)
      return elsewhere
    })
    expect(stderr).toContain('not one the agent-files job updates')
    expect(stderr).toContain('.local/bin/cairn')
    expect(stderr).not.toContain('sync-agent-files.mjs')
    // a path with a space is quoted so the line can be pasted
    expect(stderr).toMatch(/cp \S+ '[^']*my copy\/cairn\.mjs'/)
    expect(stdout).not.toContain('agent-files')
  })

  it('names the per-host command for a managed copy', async () => {
    const { stderr, stdout } = await runCli(await serve(release(), drifted), managedCopy)
    expect(stderr).toContain('sync-agent-files.mjs --source release')
    expect(stderr).not.toContain('not one the agent-files job updates')
    expect(stdout).not.toContain('sync-agent-files')
  })

  it('counts a symlink to a managed copy as managed', async () => {
    const { stderr } = await runCli(await serve(release(), drifted), async (home) => {
      const managed = await managedCopy(home)
      const link = join(home, 'link-to-cairn')
      await symlink(managed, link)
      return link
    })
    expect(stderr).toContain('sync-agent-files.mjs --source release')
  })

  it('stays silent on the same release and file whatever the build says', async () => {
    const own = createHash('sha256').update(readFileSync('cli/cairn.mjs')).digest('hex').slice(0, 16)
    const { stderr } = await runCli(await serve(release(), own, '2001-01-01T00:00:00Z'))
    expect(stderr).toBe('')
  })
})
