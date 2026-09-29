/**
 * The page a request was for, set by the middleware on every request it lets
 * through. A layout cannot read its own URL, and without this a stale session
 * — cookie present, so the middleware passed it — was sent to a bare /login
 * and landed on / after signing in instead of where it was going (a
 * `/connect/<code>` approval, above all).
 */
export const REQUESTED_PATH_HEADER = 'x-cairn-path'

/** A same-site path, or `/`. `/\host` is refused too: browsers read it as `//host`. */
export const safeRedirect = (value: string | null | undefined): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'

export const loginUrlFor = (path: string | null | undefined): string => {
  const target = safeRedirect(path)
  return target === '/' ? '/login' : `/login?redirect=${encodeURIComponent(target)}`
}
