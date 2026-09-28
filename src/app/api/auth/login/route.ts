import { compare } from 'bcryptjs'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createSession } from '@/lib/auth/session'
import type { UserRole } from '@/lib/api/actor'
import { pool } from '@/lib/db/client'
import { clientAddress } from '@/lib/api/client-address'

const bodySchema = z.object({ email: z.string().email(), password: z.string().min(1).max(1024) })
const attempts = new Map<string, { count: number; resetAt: number }>()
const WINDOW_MS = 15 * 60_000
const MAX_PER_ADDRESS = 8
const MAX_PER_ACCOUNT = 30

/**
 * Failures are counted twice: per address, and per account. The address is
 * only as good as the proxy chain (lib/api/client-address.ts); the account
 * cannot be spoofed at all, so guessing one person's password is capped even
 * from a thousand addresses. The account cap is the looser of the two on
 * purpose: it also lets anyone who knows an email lock its owner out for the
 * window, so it is set where guessing stays hopeless and a lockout takes
 * several addresses' worth of attempts. Per process, so each replica counts
 * on its own.
 */
const blocked = (key: string, now: number) => {
  const current = attempts.get(key)
  const limit = key.startsWith('account:') ? MAX_PER_ACCOUNT : MAX_PER_ADDRESS
  return Boolean(current && current.resetAt > now && current.count >= limit)
}
const fail = (key: string, now: number) => {
  const current = attempts.get(key)
  attempts.set(key, { count: current && current.resetAt > now ? current.count + 1 : 1, resetAt: now + WINDOW_MS })
}

export const POST = async (request: Request) => {
  const addressKey = `ip:${clientAddress(request.headers)}`
  const now = Date.now()
  if (blocked(addressKey, now)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 })
  const accountKey = `account:${parsed.data.email.trim().toLowerCase()}`
  if (blocked(accountKey, now)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }

  const { rows } = await pool().query<{
    id: string
    email: string
    encrypted_password: string
    role: UserRole
    display_name: string
    session_epoch: string
  }>(
    `select u.id, u.email, u.encrypted_password, u.role, u.session_epoch::text,
            coalesce(nullif(trim(p.display_name), ''), u.email) as display_name
       from app_users u
       left join user_profiles p on p.id = u.id
      where lower(u.email) = lower($1) and u.deleted_at is null
        and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
      limit 1`,
    [parsed.data.email.trim()],
  )
  const user = rows[0]
  const valid = Boolean(user?.encrypted_password) && await compare(parsed.data.password, user!.encrypted_password)
  if (!valid) {
    fail(addressKey, now)
    fail(accountKey, now)
    return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 })
  }
  attempts.delete(addressKey)
  attempts.delete(accountKey)
  await createSession({
    id: user!.id,
    email: user!.email,
    displayName: user!.display_name,
    role: user!.role,
    sessionEpoch: user!.session_epoch,
  })
  return NextResponse.json({ ok: true })
}
