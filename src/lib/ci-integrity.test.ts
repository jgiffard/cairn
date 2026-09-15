import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release validation boundary', () => {
  it('allows production deploy only after the main CI workflow succeeds', () => {
    const deploy = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toContain('workflow_run:')
    expect(deploy).toContain('workflows: [ci]')
    expect(deploy).toContain("workflow_run.conclusion == 'success'")
    expect(deploy).toContain("workflow_run.event == 'push'")
    expect(deploy).toContain("workflow_run.head_branch == 'main'")
    expect(deploy).toContain('workflow_run.head_repository.full_name == github.repository')
    expect(deploy).not.toContain('workflow_dispatch:')
    expect(deploy).not.toMatch(/\n\s+push:\s*\n/)
  })

  it('makes PostgreSQL integrity coverage a blocking CI job', () => {
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('image: postgres:16')
    expect(ci).toContain('npm run db:migrate')
    expect(ci).toContain('npm run test:integration')
  })
})
