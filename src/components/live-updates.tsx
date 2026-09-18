'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useLiveStatus } from '@/components/live-status'

/**
 * Reflects changes made by an agent while a human is looking at the page.
 *
 * The stream only reports THAT something changed; this then asks the server
 * for the new state through the normal render path. It deliberately does not
 * patch the DOM from the event: applying diffs client-side would be a second,
 * partial implementation of every view.
 *
 * It also reports its connection state to `LiveStatusProvider`, which is what
 * the indicator in the corner shows. Reporting is best-effort: with no
 * provider mounted this still refreshes exactly as before.
 */
export const LiveUpdates = ({ projectKey }: { projectKey?: string }) => {
  const router = useRouter()
  const [stale, setStale] = useState(false)
  const status = useLiveStatus()
  const report = status?.report

  useEffect(() => {
    const url = projectKey
      ? `/api/v1/events?project=${encodeURIComponent(projectKey)}`
      : '/api/v1/events'
    const source = new EventSource(url)
    // Tracked so it cannot fire after this page is gone and re-assert `live`
    // over the `idle` that cleanup just set.
    let settle: ReturnType<typeof setTimeout> | undefined

    report?.({ state: 'connecting' })

    // `ready` is sent once the server has its first fingerprint, which is a
    // truer "connected" than onopen: onopen fires when the socket is up, not
    // when the stream can actually answer.
    source.addEventListener('ready', () => report?.({ state: 'live' }))

    source.onerror = () => {
      // EventSource retries on its own, and the server closes the stream every
      // ten minutes by design, so this is a normal periodic event rather than
      // a fault. Only CLOSED is terminal.
      report?.({ state: source.readyState === EventSource.CLOSED ? 'idle' : 'reconnecting' })
    }

    source.addEventListener('changed', () => {
      report?.({ state: 'updating', changedAt: new Date().toISOString() })

      // Never refresh while the user is typing — a rerender mid-sentence
      // would be worse than being slightly out of date. Offer instead.
      const el = document.activeElement
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)

      if (typing) setStale(true)
      else router.refresh()

      // The refresh is a server round trip with no completion callback here,
      // so settle back to `live` on the next tick rather than claiming to know
      // when it landed. The indicator is a liveness signal, not a progress bar.
      clearTimeout(settle)
      settle = setTimeout(() => report?.({ state: 'live' }), 600)
    })

    return () => {
      clearTimeout(settle)
      source.close()
      // The page that owned this stream is going away; a stale `live` badge
      // would outlive it and claim a connection that no longer exists.
      report?.({ state: 'idle' })
    }
  }, [router, projectKey, report])

  if (!stale) return null

  return (
    <button
      type="button"
      onClick={() => {
        setStale(false)
        router.refresh()
      }}
      className="bg-accent text-accent-fg pop fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full px-3 py-1.5 text-[0.75rem] font-medium raised"
    >
      Updated elsewhere — refresh
    </button>
  )
}
