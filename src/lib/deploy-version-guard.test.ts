import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Input = {
  version: string; tags: string[]; treeEqual?: boolean; commitsPast?: number
  headSha?: string; tagSha?: string
}
const script = join(process.cwd(), 'scripts/deploy-version-guard.mjs')
const { decideDeployVersion } = await import(/* @vite-ignore */ script) as {
  decideDeployVersion: (input: Input) => { allowed: boolean; message: string }
}
const directories: string[] = []
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), 'cairn-deploy-guard-'))
  directories.push(path)
  return path
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
}).trim()
const repository = () => {
  const cwd = temp()
  git(cwd, 'init', '--quiet')
  git(cwd, 'config', 'user.name', 'Guard test')
  git(cwd, 'config', 'user.email', 'guard@example.test')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'tag.gpgsign', 'false')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.25.1' }))
  git(cwd, 'add', 'package.json')
  git(cwd, 'commit', '--quiet', '-m', 'release')
  return cwd
}
const run = (cwd: string) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
const input = { version: '0.25.1', tags: ['v0.25.1'], headSha: 'abcdef012345', tagSha: '123456789abc', commitsPast: 20 }

describe('deploy version decision', () => {
  it('refuses a different tree and names the commits and release commands', () => {
    const decision = decideDeployVersion({ ...input, treeEqual: false })
    expect(decision.allowed).toBe(false)
    for (const text of ['abcdef0', '0.25.1', '1234567', '20 commits past v0.25.1',
      'drove release 0.25.2 --prepare', 'node scripts/release.mjs 0.25.2 --confirm', 'publish']) {
      expect(decision.message).toContain(text)
    }
  })

  it('allows an untagged version at least as new as the newest release', () => {
    expect(decideDeployVersion({ ...input, version: '0.25.2' }).allowed).toBe(true)
  })

  it('allows the tagged tree at a different commit', () => {
    expect(decideDeployVersion({ ...input, treeEqual: true }).allowed).toBe(true)
  })

  it('orders release tags numerically and ignores other tags', () => {
    const tags = ['v0.25.10', 'v0.25.9', 'v99.0.0-rc.1', '99.0.0', 'unrelated']
    const older = decideDeployVersion({ version: '0.25.9', tags, treeEqual: true })
    expect(older.allowed).toBe(false)
    expect(older.message).toContain('newest tag v0.25.10')
    expect(decideDeployVersion({ version: '0.25.11', tags }).allowed).toBe(true)
    expect(decideDeployVersion({ version: '0.25.10', tags, treeEqual: true }).allowed).toBe(true)
  })

  it('refuses missing release tags and invalid versions', () => {
    for (const tags of [[], ['unrelated', 'v1.0.0-rc.1']]) {
      expect(decideDeployVersion({ ...input, tags })).toMatchObject({ allowed: false, message: expect.stringContaining('fetch tags: fetch-depth 0') })
    }
    expect(decideDeployVersion({ ...input, version: 'main' }).allowed).toBe(false)
  })
})

describe('deploy version command', () => {
  it('exits 1 on a changed tree and writes the refusal to stderr', () => {
    const cwd = repository()
    git(cwd, 'tag', '-a', 'v0.25.1', '-m', 'release')
    const tagSha = git(cwd, 'rev-parse', 'HEAD').slice(0, 7)
    writeFileSync(join(cwd, 'changed.txt'), 'new server')
    git(cwd, 'add', 'changed.txt')
    git(cwd, 'commit', '--quiet', '-m', 'new code')
    const result = run(cwd)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    for (const text of [git(cwd, 'rev-parse', '--short=7', 'HEAD'), tagSha, 'version 0.25.1',
      '1 commits past v0.25.1', 'drove release 0.25.2 --prepare', 'node scripts/release.mjs 0.25.2 --confirm']) {
      expect(result.stderr).toContain(text)
    }
  })

  it('exits 0 for an untagged release using package.json at HEAD', () => {
    const cwd = repository()
    git(cwd, 'tag', 'v0.25.0')
    // A dirty file cannot change which version the checkout would deploy.
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    const result = run(cwd)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('v0.25.1 is not tagged yet')
  })

  it('exits 0 for a new commit with the same tagged tree', () => {
    const cwd = repository()
    git(cwd, 'tag', 'v0.25.1')
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'same tree merge')
    expect(run(cwd)).toMatchObject({ status: 0, stderr: '', stdout: expect.stringContaining('same tree as v0.25.1') })
  })

  it('fails loudly for no checkout, missing tags and shallow history', () => {
    const cwd = repository()
    const missing = run(cwd)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('fetch tags: fetch-depth 0')
    const outside = run(temp())
    expect(outside.status).toBe(1)
    expect(outside.stderr).toContain('fetch tags: fetch-depth 0')
    git(cwd, 'tag', 'v0.25.0')
    const clone = join(temp(), 'clone')
    git(cwd, 'clone', '--quiet', '--depth=1', `file://${cwd}`, clone)
    const shallow = run(clone)
    expect(shallow.status).toBe(1)
    expect(shallow.stderr).toContain('shallow git checkout; fetch tags: fetch-depth 0')
  })
})

describe('deploy workflow version boundary', () => {
  it('fails the gate with an annotation and best effort Discord, before the deploy job', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
    const gate = workflow.split('\n  gate:\n')[1]!.split('\n  deploy:\n')[0]!
    expect(gate).toMatch(/uses: actions\/checkout@v4[\s\S]*ref: \$\{\{ github.event.workflow_run.head_sha \}\}[\s\S]*fetch-depth: 0\n\s+fetch-tags: true/)
    expect(gate).toContain("if: steps.tip.outputs.current == 'true'")
    expect(workflow).toMatch(/\n  deploy:\n    needs: gate\n    if: needs\.gate\.outputs\.current == 'true'/)
    expect(gate).not.toContain('continue-on-error:')
    expect(gate).not.toContain('roll back on failure')
    const body = gate.split('      - name: guard deploy version\n')[1]!.split('        run: |\n')[1]!
      .split('\n').map((line) => line.replace(/^          /, '')).join('\n')
    // Exercise the real gate shell with a refusal and a failed notifier.
    const result = spawnSync('bash', ['-c', `node() { printf '%s\\n' 'refusal 100% detail' >&2; return 1; }\nsudo() { printf 'NOTIFY %s\\n' "$*"; return 1; }\n${body}`], {
      cwd: temp(), encoding: 'utf8', env: { ...process.env, SHA: 'abcdef012345' },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::refusal 100%25 detail')
    expect(result.stdout).toContain('🛑 Cairn deploy refused `abcdef0` refusal 100% detail')
    expect(result.stdout).toContain('::warning::Discord refusal notification failed')
    expect(result.stdout.match(/NOTIFY /g)).toHaveLength(1)
  })
})
