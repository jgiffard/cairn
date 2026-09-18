'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { RelativeTime } from '@/components/relative-time'

/**
 * Whether what you are reading is still true.
 *
 * Cairn does not poll from the client — `LiveUpdates` holds an SSE stream that
 * says only THAT something moved, and the page then re-renders through its
 * normal server path (see CAIRN-152). That is cheaper and more responsive than
 * a timer, but it is also invisible: a stream that quietly died looks exactly
 * like a workspace where nothing is happening, and an agent's findings land on
 * a page that never updates again. This says which of the two you are in.
 *
 * A countdown was the obvious thing to build and would have been a lie: the
 * server decides when to check, the browser is never told the schedule, so a
 * client-side timer would tick along happily over a dead connection.
 */
export type LiveState =
  /** No stream on this page. Not every page subscribes, and that is fine. */
  | 'idle'
  | 'connecting'
  | 'live'
  /** A change just arrived and the refresh is in flight. */
  | 'updating'
  /** EventSource dropped and is retrying on its own. */
  | 'reconnecting'

type Report = { state: LiveState; changedAt?: string }

type Ctx = {
  state: LiveState
  /** When the data last actually moved, not when we last connected. */
  changedAt: string | null
  report: (next: Report) => void
}

const LiveStatusContext = createContext<Ctx | null>(null)

export const LiveStatusProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, setState] = useState<LiveState>('idle')
  const [changedAt, setChangedAt] = useState<string | null>(null)

  // Stable, so subscribing does not re-run the effect that owns the stream.
  const report = useCallback((next: Report) => {
    setState(next.state)
    if (next.changedAt) setChangedAt(next.changedAt)
  }, [])

  const value = useMemo(() => ({ state, changedAt, report }), [state, changedAt, report])

  return <LiveStatusContext.Provider value={value}>{children}</LiveStatusContext.Provider>
}

/**
 * Returns null rather than throwing when there is no provider, so `LiveUpdates`
 * keeps working anywhere it is mounted — reporting status is an extra, not a
 * requirement for refreshing to work.
 */
export const useLiveStatus = () => useContext(LiveStatusContext)

const LOOK: Record<LiveState, { dot: string; label: string; title: string }> = {
  idle: {
    dot: 'bg-fg-subtle/40',
    label: 'Not live',
    title: 'This page does not subscribe to updates. Reload to see changes.',
  },
  connecting: {
    dot: 'bg-fg-subtle animate-pulse',
    label: 'Connecting',
    title: 'Opening the update stream.',
  },
  live: {
    dot: 'bg-status-done',
    label: 'Live',
    title: 'Connected. This page updates itself when anything changes.',
  },
  updating: {
    dot: 'bg-accent animate-pulse',
    label: 'Updating',
    title: 'A change arrived; fetching the new state.',
  },
  reconnecting: {
    dot: 'bg-status-in-review animate-pulse',
    label: 'Reconnecting',
    title:
      'The stream dropped and is retrying. The stream also closes itself every ten minutes by design, so this is normal and brief.',
  },
}

export const LiveStatusIndicator = () => {
  const ctx = useLiveStatus()
  if (!ctx) return null

  const look = LOOK[ctx.state]

  return (
    <div
      role="status"
      // Not aria-live: this changes on its own every few minutes and would
      // interrupt a screen reader mid-sentence for no decision the reader has
      // to make. It stays reachable on demand instead.
      aria-label={`${look.label}. ${look.title}`}
      title={look.title}
      className="border-border bg-surface/90 text-fg-subtle pointer-events-none fixed top-2.5 right-2.5 z-30 flex items-center gap-1.5 rounded-full border px-2 py-1 text-[0.6875rem] backdrop-blur-sm"
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${look.dot}`} />
      {/* Narrow screens get the dot alone. The label is the first thing worth
          dropping: the colour already carries the state, the accessible name
          still reads in full, and a phone header has no room to spare — this
          badge was truncating "Show 2988 closed" before it was reserved for. */}
      <span className="hidden sm:inline">{look.label}</span>
      {/* Only once something has actually changed: "updated just now" on a
          page that has sat still since it loaded would be untrue. */}
      {ctx.changedAt && ctx.state !== 'idle' && (
        <span className="hidden items-center gap-1.5 md:inline-flex">
          <span aria-hidden className="bg-border h-2.5 w-px" />
          <RelativeTime iso={ctx.changedAt} refreshMs={15_000} className="tabular" />
        </span>
      )}
    </div>
  )
}
