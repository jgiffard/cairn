import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A project key change must stay additive.
 *
 * A ref is designed to escape — into commit messages, PR titles, other agents'
 * notes — and those are immutable, so a rename that drops the old key silently
 * invalidates every reference already issued. The former key is therefore kept
 * and keeps resolving.
 *
 * Three pieces make that true, in three different files, and any one of them
 * reverting on its own would restore the silence without failing anything:
 * the rename has to be atomic with recording the old key, lookups have to fall
 * back to retired keys, and the renderer has to keep linkifying them.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('renaming a project key keeps old refs working', () => {
  it('renames through the function that records the former key', () => {
    const route = read('src/app/api/v1/projects/[id]/route.ts')
    expect(route).toContain('project_rename_key')
    // The original bug in one line: `key` inside a general field update, which
    // changes the key and records nothing.
    expect(route).not.toMatch(/\.update\(body\)/)
  })

  it('resolves a ref through a retired key when the live key misses', () => {
    expect(read('src/lib/api/tasks.ts')).toContain('projectIdForFormerKey')
  })

  it('still linkifies refs written under a retired key', () => {
    // Bare refs are matched against this list at render time. A former key
    // missing from it is the case where an old ref still looks like a ref, is
    // still a link, and leads nowhere — the store breaking its own
    // cross-references.
    expect(read('src/app/(app)/layout.tsx')).toContain('listFormerKeys')
  })

  it('shows the former ref, not only resolves it', () => {
    // Resolution alone is half an answer: the lookup succeeds but the screen
    // shows the new ref, so a reader holding the old one cannot tell they
    // found the right task.
    expect(read('src/app/(app)/projects/[key]/tasks/[number]/page.tsx')).toContain('formerKeysFor')
  })

  it('refuses to reuse a key another project retired', () => {
    // Reuse would leave every ACME-n ref resolving to two different tasks,
    // which is worse than refusing the rename.
    const migration = read('migrations/031_project_former_keys.sql')
    expect(migration).toContain('retired by another project')
    // One former key, one project, per owner — the constraint the refusal rests on.
    expect(migration).toMatch(/primary key \(owner_user_id, key\)/)
  })
})
