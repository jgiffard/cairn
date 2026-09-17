import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('browser session generations', () => {
  it('uses a session-only epoch from login through validation', () => {
    const migration = read('migrations/046_multi_user_roles.sql')
    const login = read('src/app/api/auth/login/route.ts')
    const sessions = read('src/lib/auth/session.ts')

    expect(migration).toContain('session_epoch bigint not null default 0')
    expect(login).toContain('u.session_epoch::text')
    expect(sessions).toContain('s.session_epoch = u.session_epoch')
  })

  it('rotates browser sessions without silently invalidating agent keys', () => {
    const operator = read('scripts/create-operator.ts')
    expect(operator).toContain('session_epoch = session_epoch + 1')
    expect(operator).not.toContain('auth_epoch = auth_epoch + 1')
  })
})