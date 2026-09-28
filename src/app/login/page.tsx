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
const LoginPage = async () => {
  if (await sessionUser()) redirect('/')
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center px-6">
          <p className="text-fg-subtle text-sm">Loading…</p>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  )
}

export default LoginPage
