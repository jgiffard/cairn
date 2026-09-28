'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronRight, Copy, KeyRound, RotateCcw, UserRoundPlus } from 'lucide-react'
import { mutate } from '@/lib/api/mutate'
import { Button, Field, Input, Select } from '@/components/ui/control'
import type { AdminUser } from '@/lib/api/users'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'

export type UserKey = {
  id: string
  agent_name: string
  name: string
  key_prefix: string
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

const errorMessage = (value: unknown) => value instanceof Error ? value.message : 'Something went wrong.'

export const UsersManager = ({ users }: { users: AdminUser[] }) => {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keys, setKeys] = useState<Record<string, UserKey[]>>({})
  const [freshKey, setFreshKey] = useState<{ userId: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const create = () => run('create', async () => {
    const result = await mutate('/api/v1/users', {
      method: 'POST',
      body: { email, displayName, password, role },
    })
    if (!result.ok) throw new Error(result.error)
    setEmail('')
    setDisplayName('')
    setPassword('')
    setRole('member')
    router.refresh()
  })

  const update = (user: AdminUser, form: HTMLFormElement) => run(`user:${user.id}`, async () => {
    const data = new FormData(form)
    const result = await mutate(`/api/v1/users/${user.id}`, {
      method: 'PATCH',
      body: {
        email: String(data.get('email') ?? ''),
        displayName: String(data.get('displayName') ?? ''),
        role: String(data.get('role') ?? 'member'),
      },
    })
    if (!result.ok) throw new Error(result.error)
    router.refresh()
  })

  const deactivate = (user: AdminUser) => {
    if (!confirm(`Disable ${user.displayName}? Their sessions and active agent keys will be revoked immediately.`)) return
    void run(`user:${user.id}`, async () => {
      const result = await mutate(`/api/v1/users/${user.id}`, { method: 'DELETE' })
      if (!result.ok) throw new Error(result.error)
      setKeys((current) => ({ ...current, [user.id]: [] }))
      router.refresh()
    })
  }

  const restore = (user: AdminUser) => run(`user:${user.id}`, async () => {
    const result = await mutate(`/api/v1/users/${user.id}/restore`, { method: 'POST' })
    if (!result.ok) throw new Error(result.error)
    router.refresh()
  })

  const resetPassword = (user: AdminUser, value: string) => run(`password:${user.id}`, async () => {
    const result = await mutate(`/api/v1/users/${user.id}/password`, {
      method: 'POST',
      body: { password: value },
    })
    if (!result.ok) throw new Error(result.error)
    alert(`Password reset for ${user.displayName}. Existing browser sessions were revoked.`)
  })

  const loadKeys = (userId: string) => run(`keys:${userId}`, async () => {
    const response = await fetch(`/api/v1/users/${userId}/keys`)
    const payload = await response.json().catch(() => null) as { data?: UserKey[]; error?: string } | null
    if (!response.ok) throw new Error(payload?.error || 'Could not load agent keys.')
    setKeys((current) => ({ ...current, [userId]: payload?.data ?? [] }))
  })

  const createKey = (userId: string, form: HTMLFormElement) => run(`keys:${userId}`, async () => {
    const data = new FormData(form)
    const result = await mutate<{ key: string }>(`/api/v1/users/${userId}/keys`, {
      method: 'POST',
      body: { agentName: String(data.get('agentName') ?? ''), name: String(data.get('name') ?? '') },
    })
    if (!result.ok) throw new Error(result.error)
    setFreshKey({ userId, key: result.data.key })
    form.reset()
    await loadKeys(userId)
  })

  const revokeKey = (userId: string, key: UserKey) => {
    if (!confirm(`Revoke the ${key.agent_name} key? That agent will stop working immediately.`)) return
    void run(`keys:${userId}`, async () => {
      const result = await mutate(`/api/v1/users/${userId}/keys/${key.id}`, { method: 'DELETE' })
      if (!result.ok) throw new Error(result.error)
      await loadKeys(userId)
    })
  }


  return (
    <div className="flex flex-col gap-8">
      <section className="surface-card overflow-hidden">
        <header className="border-border flex items-center gap-2 border-b px-4 py-3">
          <UserRoundPlus size={15} className="text-fg-muted" aria-hidden />
          <h2 className="text-[0.8125rem] font-medium">Create user</h2>
        </header>
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
          <Field label="Display name">
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          </Field>
          <Field label="Initial password">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} autoComplete="new-password" />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>
        </div>
        <footer className="border-border bg-surface-raised/30 flex justify-end border-t px-4 py-2.5">
          <Button className="w-auto" variant="primary" onClick={() => void create()} disabled={busy === 'create' || !email || !displayName || password.length < 12}>
            {busy === 'create' ? 'Creating…' : 'Create user'}
          </Button>
        </footer>
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-fg-muted text-[0.65625rem] font-medium tracking-[0.06em] uppercase">Workspace users</h2>
          <span className="text-fg-subtle tabular text-[0.6875rem]">{users.length}</span>
          <span className="ml-1 h-px flex-1 self-center bg-[linear-gradient(90deg,var(--border-strong),transparent)]" />
        </div>
        <div className="stagger flex flex-col gap-3">
          {users.map((user) => (
            <article key={user.id} className={cn('surface-card p-4', !user.active && 'opacity-80')}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <strong className="text-[0.8125rem] font-medium">{user.displayName}</strong>
                <span
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide',
                    user.role === 'admin'
                      ? 'border-accent/40 bg-accent-subtle/60 text-accent'
                      : 'border-border text-fg-muted',
                  )}
                >
                  {user.role}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-[0.6875rem]',
                    user.active ? 'text-status-in-review' : 'text-danger',
                  )}
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {user.active ? 'Active' : 'Disabled'}
                </span>
                <span className="text-fg-subtle tabular ml-auto text-[0.6875rem]">{user.activeKeyCount} active keys</span>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void update(user, event.currentTarget) }}>
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
                  <Field label="Display name"><Input name="displayName" defaultValue={user.displayName} disabled={!user.active} /></Field>
                  <Field label="Email"><Input name="email" type="email" defaultValue={user.email} disabled={!user.active} /></Field>
                  <Field label="Role">
                    <Select name="role" defaultValue={user.role} disabled={!user.active}>
                      <option value="member">Member</option>
                      <option value="admin">Administrator</option>
                    </Select>
                  </Field>
                </div>
                {user.active && (
                  <div className="mt-3">
                    <Button size="sm" type="submit" disabled={busy === `user:${user.id}`}>Save changes</Button>
                  </div>
                )}
              </form>
              <div className="mt-3 flex flex-wrap gap-2">
                {user.active ? (
                  <Button type="button" size="sm" variant="danger" onClick={() => deactivate(user)} disabled={busy === `user:${user.id}`}>Disable user</Button>
                ) : (
                  <Button type="button" size="sm" onClick={() => void restore(user)} disabled={busy === `user:${user.id}`}>
                    <RotateCcw size={12} aria-hidden /> Restore user
                  </Button>
                )}
              </div>

              {user.active && (
                <div className="border-border mt-4 border-t pt-3">
                  <details className="group">
                    <summary className="text-fg-muted hover:text-fg flex w-fit cursor-pointer list-none items-center gap-1.5 text-[0.75rem] font-medium transition-colors duration-[var(--dur-1)] [&::-webkit-details-marker]:hidden">
                      <ChevronRight size={12} aria-hidden className="transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)] group-open:rotate-90" />
                      Password and agent keys
                    </summary>
                    <div className="enter-rise">
                      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => {
                        event.preventDefault()
                        const value = String(new FormData(event.currentTarget).get('password') ?? '')
                        void resetPassword(user, value)
                        event.currentTarget.reset()
                      }}>
                        <Field label="New password"><Input name="password" type="password" minLength={12} required autoComplete="new-password" className="w-64" /></Field>
                        <Button size="sm" type="submit" disabled={busy === `password:${user.id}`}>Reset password</Button>
                      </form>

                      <div className="mt-5">
                        {keys[user.id] === undefined ? (
                          <Button size="sm" variant="quiet" onClick={() => void loadKeys(user.id)} disabled={busy === `keys:${user.id}`}>
                            <KeyRound size={12} aria-hidden /> {busy === `keys:${user.id}` ? 'Loading…' : 'Manage agent keys'}
                          </Button>
                        ) : (
                          <>
                            <ul className="border-border divide-border stagger mb-3 divide-y overflow-hidden rounded-md border">
                              {(keys[user.id] ?? []).length === 0 && (
                                <li><EmptyState compact title="No agent keys." /></li>
                              )}
                              {(keys[user.id] ?? []).map((key) => (
                                <li key={key.id} className="row-hover flex min-h-[2.25rem] flex-wrap items-center gap-2 px-2.5 py-1.5 text-[0.6875rem]">
                                  <span className={key.revoked_at ? 'line-through text-fg-subtle' : 'text-fg'}>{key.agent_name}</span>
                                  <code className="text-fg-subtle">{key.key_prefix}…</code>
                                  {!key.revoked_at && <Button type="button" size="sm" variant="danger" className="ml-auto h-6" onClick={() => revokeKey(user.id, key)}>Revoke</Button>}
                                </li>
                              ))}
                            </ul>
                            {freshKey?.userId === user.id && (
                              <div className="border-accent/50 bg-accent-subtle/60 enter-rise mb-3 rounded-md border p-3 shadow-[0_0_18px_-8px_var(--glow)]">
                                <p className="mb-2 text-[0.6875rem] font-medium">New key — shown once</p>
                                <div className="flex items-center gap-2">
                                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[0.6875rem]">{freshKey.key}</code>
                                  <Button size="sm" variant="primary" onClick={async () => {
                                    await navigator.clipboard.writeText(freshKey.key)
                                    setCopied(true)
                                    setTimeout(() => setCopied(false), 1600)
                                  }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</Button>
                                </div>
                              </div>
                            )}
                            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void createKey(user.id, event.currentTarget) }}>
                              <Field label="Agent name"><Input name="agentName" required pattern="[a-z][a-z0-9-]{1,40}" placeholder="claude-code" className="w-40" /></Field>
                              <Field label="Key label"><Input name="name" required placeholder="Workstation key" className="w-44" /></Field>
                              <Button size="sm" type="submit" disabled={busy === `keys:${user.id}`}>Create key</Button>
                            </form>
                          </>
                        )}
                      </div>
                    </div>
                  </details>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      {error && (
        <p role="alert" className="text-danger bg-danger-subtle enter-rise rounded-md px-3 py-2 text-[0.75rem]">
          {error}
        </p>
      )}
    </div>
  )
}
