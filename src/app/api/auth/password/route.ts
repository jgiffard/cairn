import { hash } from 'bcryptjs'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionUser } from '@/lib/auth/session'
import { transaction } from '@/lib/db/client'

const bodySchema = z.object({ password: z.string().min(12).max(1024) })

export const POST = async (request: Request) => {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Password must be at least 12 characters.' }, { status: 400 })
  const encrypted = await hash(parsed.data.password, 12)
  await transaction(async (client) => {
    await client.query(
      `update app_users
          set encrypted_password = $1,
              session_epoch = session_epoch + 1,
              updated_at = now()
        where id = $2`,
      [encrypted, user.id],
    )
    await client.query('delete from app_sessions where user_id = $1', [user.id])
  })
  return NextResponse.json({ ok: true })
}
