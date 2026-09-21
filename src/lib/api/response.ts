import { NextResponse } from 'next/server'
import { version as RELEASE } from '../../../package.json'

/**
 * Every response says which version served it, so a stale CLI can notice
 * without being asked.
 *
 * `cairn --version` already compares the two, but that is the one command an
 * agent has no reason to run — so a copy that has drifted goes on working,
 * just not the way the docs say, until something it needs is missing. Putting
 * the number on the ordinary path costs a header and turns discovery-by-
 * accident into discovery.
 */
export const VERSION_HEADER = 'x-cairn-version'

const withVersion = (init?: ResponseInit): ResponseInit => {
  const headers = new Headers(init?.headers)
  headers.set(VERSION_HEADER, RELEASE)
  return { ...init, headers }
}

export type ApiError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'already_claimed'
  | 'resolution_required'
  | 'rate_limited'
  | 'internal_error'

const STATUS: Record<ApiError, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  already_claimed: 409,
  resolution_required: 400,
  rate_limited: 429,
  internal_error: 500,
}

export const ok = <T>(data: T, init?: ResponseInit) =>
  NextResponse.json({ success: true, data }, withVersion(init))

/**
 * Errors carry a machine-readable `code` and, where the failure is a bad
 * enum value, the list of valid ones. An agent that gets told what is
 * acceptable can retry correctly; one that just gets "400" cannot.
 */
export const fail = (code: ApiError, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json(
    { success: false, error, code, ...extra },
    withVersion({ status: STATUS[code] }),
  )

export const failValidation = (issues: unknown) =>
  NextResponse.json(
    { success: false, error: 'Validation failed', code: 'validation_failed', issues },
    withVersion({ status: 400 }),
  )
