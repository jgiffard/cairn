import { headers } from 'next/headers'
import { loginUrlFor, REQUESTED_PATH_HEADER } from './login-redirect'

/** Where a signed-out server component sends the visitor, destination kept. */
export const loginRedirectTarget = async (): Promise<string> =>
  loginUrlFor((await headers()).get(REQUESTED_PATH_HEADER))
