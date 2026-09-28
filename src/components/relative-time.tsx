'use client'

import { useEffect, useState } from 'react'
import { useMounted } from '@/lib/use-mounted'
import { fullDateTime, relativeTime, shortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

/**
 * "3m ago", without a hydration mismatch.
 *
 * The server has no idea what time it is in the reader's browser, and guessing
 * guarantees a mismatch. So the first render — server and client alike — is
 * the absolute date, and the relative form appears once mounted. It then keeps
 * itself current, which a server-rendered string never could.
 */
export const RelativeTime = ({
  iso,
  className,
  refreshMs = 60_000,
}: {
  iso: string
  className?: string
  refreshMs?: number
}) => {
  const mounted = useMounted()
  // Initialised eagerly rather than in an effect. It is computed on the server
  // too, but only *read* once mounted, so hydration never sees it.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), refreshMs)
    return () => clearInterval(timer)
  }, [refreshMs])

  return (
    // Tabular, so "9m ago" turning into "10m ago" under a live refresh does
    // not nudge whatever sits beside it.
    <time dateTime={iso} title={fullDateTime(iso)} className={cn('tabular-nums', className)}>
      {mounted ? relativeTime(iso, now) : shortDate(iso)}
    </time>
  )
}
