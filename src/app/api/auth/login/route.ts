import { compare } from 'bcryptjs'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createSession } from '@/lib/auth/session'
import type { UserRole } from '@/lib/api/actor'
import { pool } from '@/lib/db/client'

const bodySchema = z.object({ email: z.string().email(), password: z.string().min(1).max(1024) })
const attempts = new Map<string, { count: number; resetAt: number }>()

export const POST = async (request: Request) => {
  const key = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const now = Date.now()
  const current = attempts.get(key)
  if (current && current.resetAt > now && current.count >= 8) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 })

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
    attempts.set(key, { count: current && current.resetAt > now ? current.count + 1 : 1, resetAt: now + 15 * 60_000 })
    return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 })
  }
  attempts.delete(key)
  await createSession({
    id: user!.id,
    email: user!.email,
    displayName: user!.display_name,
    role: user!.role,
    sessionEpoch: user!.session_epoch,
  })
  return NextResponse.json({ ok: true })
}
