import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminUser } from '@/lib/api/users'
import { UsersManager } from './users-manager'

const { mutateMock, refreshMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  refreshMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))

const user = (overrides: Partial<AdminUser>): AdminUser => ({
  id: 'active-user',
  email: 'active@example.test',
  displayName: 'Active User',
  role: 'member',
  active: true,
  deletedAt: null,
  bannedUntil: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  keyCount: 1,
  activeKeyCount: 1,
  ...overrides,
})

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const buttonNamed = (root: HTMLElement, name: string) => {
  const button = [...root.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === name)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return button
}

describe('UsersManager destructive actions', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
    refreshMock.mockReset()
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: 'key-1',
          agent_name: 'clawclaw',
          name: 'Workstation',
          key_prefix: 'cairn_abcd',
          last_used_at: null,
          revoked_at: null,
          created_at: '2026-09-17T00:00:00.000Z',
        }],
      }),
    }))
    await act(async () => {
      root.render(<UsersManager users={[
        user({}),
        user({
          id: 'disabled-user',
          email: 'disabled@example.test',
          displayName: 'Disabled User',
          active: false,
          deletedAt: '2026-09-17T01:00:00.000Z',
          keyCount: 0,
          activeKeyCount: 0,
        }),
      ]} />)
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps Disable, Restore, and Revoke outside edit forms and never PATCHes user edits', async () => {
    const disable = buttonNamed(container, 'Disable user')
    const restore = buttonNamed(container, 'Restore user')

    expect(disable.type).toBe('button')
    expect(restore.type).toBe('button')
    expect(disable.form).toBeNull()
    expect(restore.form).toBeNull()

    await click(buttonNamed(container, 'Manage agent keys'))

    const revoke = buttonNamed(container, 'Revoke')
    expect(revoke.type).toBe('button')
    expect(revoke.form).toBeNull()
    await click(revoke)
    await click(disable)
    await click(restore)

    expect(mutateMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'PATCH' }),
    )
  })
})
