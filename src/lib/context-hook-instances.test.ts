import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * CAIRN-297. With several instances and no route for the directory, `cairn
 * context` exits 10 and says on stderr what to ask the user. That is the one
 * failure the briefing hook must not swallow: an agent told nothing finds out
 * at its first write, after the moment to ask has passed.
 */
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const script = async (dir: string, name: string, body: string) => {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

const hook = async (cairnScript: string, { env = {}, croft, trig, event = 'SessionStart' }: {
  env?: Record<string, string>
  croft?: string
  trig?: string
  event?: string
} = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-context-hook-'))
  directories.push(dir)
  const cli = await script(dir, 'cairn', cairnScript)
  const siblings = {
    TRIG_CLI: trig ? await script(dir, 'trig', trig) : join(dir, 'no-trig'),
    CROFT_CLI: croft ? await script(dir, 'croft', croft) : join(dir, 'no-croft'),
  }
  return new Promise<{ code: number | null; stdout: string; dir: string; context: () => string }>((resolve) => {
    const child = spawn('node', ['hooks/cairn-context.mjs'], {
      env: { ...process.env, CAIRN_CLI: cli, ...siblings, ...env },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('close', (code) => resolve({
      code,
      stdout,
      dir,
      context: () => JSON.parse(stdout).hookSpecificOutput.additionalContext,
    }))
    child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: '/work/client-site', tool_input: { file_path: '/work/client-site/a.ts' } }))
  })
}

describe('the briefing hook on a machine with several instances', () => {
  it("passes on the CLI's instruction to ask when the directory has no instance", async () => {
    const { code, stdout } = await hook('echo "cairn: nothing says which one ~/work/client-site is for. Ask the user" >&2; exit 10')
    expect(code).toBe(0)
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('Ask the user')
  })

  it('stays silent on any other failure, as before', async () => {
    const { stdout } = await hook('echo "boom" >&2; exit 1')
    expect(stdout).toBe('')
  })
})

/**
 * Croft installs no session hook where Cairn's runs, so its brief rides at
 * the end of Cairn's, the way Trig's line does: same deadline, same silence.
 */
describe('the briefing hook with sibling products', () => {
  const CAIRN = 'printf "## Cairn [ACME]\\nHolding ACME-1\\n"'

  it("appends Croft's brief for this directory after Cairn's block", async () => {
    const { code, context } = await hook(CAIRN, {
      croft: 'printf "## Croft\\nargs=%s\\nS-12 exploring: edge cache\\n\\n" "$*"',
    })
    expect(code).toBe(0)
    expect(context()).toBe('## Cairn [ACME]\nHolding ACME-1\n## Croft\nargs=context --brief --cwd /work/client-site\nS-12 exploring: edge cache')
  })

  it('keeps the Trig line as it was, with Croft after it', async () => {
    const finishedAt = new Date().toISOString()
    const { context } = await hook(CAIRN, {
      trig: `printf '[{"finishedAt":"${finishedAt}"}]'`,
      croft: 'echo "## Croft"',
    })
    expect(context()).toBe(
      '## Cairn [ACME]\nHolding ACME-1\nTrig — the map of what exists (scanned within the hour):\n  trig what-is <thing> · trig impact <thing> · trig inbox\n\n## Croft',
    )
  })

  it('speaks for Croft alone when Cairn has nothing to say', async () => {
    const { context } = await hook('exit 1', { croft: 'echo "## Croft"' })
    expect(context()).toBe('## Croft')
  })

  it('clips a long brief to five lines and 600 bytes', async () => {
    const lines = await hook(CAIRN, { croft: 'for i in 1 2 3 4 5 6 7 8; do echo "line $i"; done' })
    expect(lines.context()).toContain('line 5')
    expect(lines.context()).not.toContain('line 6')

    const bytes = await hook(CAIRN, { croft: `printf '%0900d\\n' 0` })
    const brief = bytes.context().split('\n').pop() ?? ''
    expect(Buffer.byteLength(brief)).toBe(600)
  })

  it('is silent when Croft fails, prints nothing, or is slow', async () => {
    for (const croft of ['echo "no board" >&2; exit 2', 'exit 0', 'sleep 5; echo "## Croft"']) {
      const started = Date.now()
      const { code, context } = await hook(CAIRN, { croft, env: { CAIRN_CROFT_TIMEOUT_MS: '200' } })
      expect(code).toBe(0)
      expect(Date.now() - started).toBeLessThan(3000)
      expect(context()).toBe('## Cairn [ACME]\nHolding ACME-1')
    }
  })

  it('finds croft in ~/.local/bin when PATH does not', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cairn-context-home-'))
    directories.push(home)
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await script(join(home, '.local', 'bin'), 'croft', 'echo "## Croft from home"')
    const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CROFT_CLI: '' }
    const { context } = await hook(CAIRN, { env })
    expect(context()).toContain('## Croft from home')
  })

  it('asks no sibling anything inside a summariser, or on a question about one file', async () => {
    for (const flag of ['CROFT_SUMMARISER', 'CAIRN_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']) {
      const env = { [flag]: '1' }
      const run = await hook(CAIRN, { env, croft: 'touch "$(dirname "$0")/asked"; echo "## Croft"' })
      expect(run.context()).toBe('## Cairn [ACME]\nHolding ACME-1')
      expect(existsSync(join(run.dir, 'asked'))).toBe(false)
    }
    const read = await hook(CAIRN, { event: 'PreToolUse', croft: 'touch "$(dirname "$0")/asked"; echo "## Croft"' })
    expect(read.context()).toBe('## Cairn [ACME]\nHolding ACME-1')
    expect(existsSync(join(read.dir, 'asked'))).toBe(false)
  })
})
