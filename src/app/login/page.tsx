import type { Metadata } from 'next'
import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { sessionUser } from '@/lib/auth/session'
import { LoginForm } from './login-form'

/**
 * The form reads `?redirect=` via useSearchParams(), which requires a Suspense
 * boundary at prerender time — hence the split.
 *
 * A signed-in visitor goes to the app, decided here against the database
 * rather than in the middleware by the cookie's mere presence: a stale cookie
 * (password changed, session expired or revoked) has to reach this form, or
 * the layout and the middleware bounce it between / and /login for ever.
 */
export const metadata: Metadata = { title: 'Sign in' }

const LoginPage = async () => {
  if (await sessionUser()) redirect('/')
  return (
    <Suspense
      fallback={
        <main className="bg-bg min-h-dvh" />
      }
    >
      <LoginForm />
    </Suspense>
  )
}

export default LoginPage
