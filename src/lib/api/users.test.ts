import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  generatedKey: {
    key: 'cairn_test_key',
    keyHash: 'test-hash',
    keyPrefix: 'cairn_test',
  },
}))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
  transaction: mocks.transaction,
}))

vi.mock('./keys', () => ({
  generateApiKey: () => mocks.generatedKey,
}))

import { createUserKey, deactivateUser, resetUserPassword, updateUser } from './users'

const activeUser = {
  id: 'user-1',
  email: 'julien@example.test',
  displayName: 'Julien',
  role: 'admin',
  active: true,
  deletedAt: null,
  bannedUntil: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  keyCount: 0,
  activeKeyCount: 0,
}

describe('user credential administration', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.transaction.mockReset()
    mocks.transaction.mockImplementation(async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) =>
      run({ query: mocks.query }),
    )
  })

  it('resets a password and revokes browser sessions without invalidating agent keys', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    await resetUserPassword(activeUser.id, 'a sufficiently long password')

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(statements[1]).toContain('session_epoch = session_epoch + 1')
    expect(statements[1]).not.toContain('auth_epoch')
    expect(statements[2]).toContain('delete from app_sessions')
    expect(statements.join('\n')).not.toContain('update api_keys')
  })

  it('locks an active user while creating an agent key at the current authentication epoch', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'key-1',
          agent_name: 'clawclaw',
          name: 'ClawClaw',
          key_prefix: mocks.generatedKey.keyPrefix,
          created_at: '2026-01-01T00:00:00.000Z',
        }],
      })

    const result = await createUserKey(activeUser.id, { agentName: 'clawclaw', name: 'ClawClaw' })

    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('for update')
    expect(String(mocks.query.mock.calls[2]?.[0])).toContain('auth_epoch')
    expect(result).toMatchObject({ id: 'key-1', key: mocks.generatedKey.key })
  })

  it('does not return plaintext for a key that was not inserted', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(createUserKey(activeUser.id, { agentName: 'clawclaw', name: 'ClawClaw' }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses to demote the final active administrator', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })

    await expect(updateUser(activeUser.id, { role: 'member' }))
      .rejects.toMatchObject({ code: 'final_admin' })

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toHaveLength(3)
    expect(statements.join('\n')).not.toContain('set email =')
  })

  it('disables a user and revokes sessions and keys in the same transaction', async () => {
    const disabledUser = { ...activeUser, active: false, deletedAt: '2026-01-02T00:00:00.000Z' }
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [disabledUser] })

    await expect(deactivateUser(activeUser.id)).resolves.toMatchObject({ active: false })

    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(statements[1]).toContain('for update')
    expect(statements[4]).toContain('auth_epoch = auth_epoch + 1')
    expect(statements[4]).toContain('session_epoch = session_epoch + 1')
    expect(statements[5]).toContain('delete from app_sessions')
    expect(statements[6]).toContain('update api_keys set revoked_at = now()')
  })
})
