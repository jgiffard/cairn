'use client'

import { InlineInput } from '@/components/ui/control'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api/mutate'
import { LabelPill } from '@/components/icons'

export type LabelRow = { label: string; task_count: number }

/**
 * Rename, merge and delete are the same control: typing an existing label as
 * the new name merges the two, which is how the drift actually gets cleaned
 * up. Said out loud in the hint rather than left to be discovered.
 */
export const LabelsSection = ({ labels }: { labels: LabelRow[] }) => {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const existing = new Set(labels.map((l) => l.label))

  const apply = async (from: string, to: string | null) => {
    setBusy(true)
    setMessage(null)
    const result = await mutate<{ tasksChanged: number }>('/api/v1/labels', {
      method: 'PATCH',
      body: { from, to },
    })
    setBusy(false)
    if (!result.ok) {
      setMessage(result.error)
      return
    }
    setEditing(null)
    setMessage(
      to === null
        ? `Removed “${from}” from ${result.data.tasksChanged} task(s).`
        : `${result.data.tasksChanged} task(s) now carry “${to}”.`,
    )
    router.refresh()
  }

  return (
    <section>
      <h2 className="text-fg text-[0.8125rem] font-medium">Labels</h2>
      <p className="text-fg-subtle mt-1 text-[0.75rem]">
        Renaming onto a label that already exists merges the two. Nothing else keeps
        <code className="mx-1">db</code>,<code className="mx-1">database</code> and
        <code className="mx-1">postgres</code> from becoming three separate things.
      </p>

      {labels.length === 0 ? (
        <p className="text-fg-subtle border-border mt-3 rounded-md border border-dashed px-3 py-4 text-center text-[0.75rem]">
          No labels in use.
        </p>
      ) : (
        <ul className="border-border divide-border mt-3 divide-y rounded-md border">
          {labels.map((l) => (
            <li key={l.label} className="flex min-h-[2.375rem] items-center gap-2 px-3 py-1.5">
              {editing === l.label ? (
                <>
                  <InlineInput
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draft.trim()) void apply(l.label, draft.trim())
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    aria-label={`Rename ${l.label}`}
                    className="min-w-0 flex-1"
                  />
                  {existing.has(draft.trim()) && draft.trim() !== l.label && (
                    <span className="text-fg-subtle shrink-0 text-[0.6875rem]">merges</span>
                  )}
                  <button
                    type="button"
                    disabled={busy || !draft.trim()}
                    onClick={() => void apply(l.label, draft.trim())}
                    className="text-accent shrink-0 text-[0.75rem] disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-fg-subtle hover:text-fg shrink-0 text-[0.75rem]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <LabelPill>{l.label}</LabelPill>
                  <span className="text-fg-subtle tabular ml-auto shrink-0 text-[0.6875rem]">
                    {l.task_count} task{l.task_count === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(l.label)
                      setDraft(l.label)
                    }}
                    className="text-fg-muted hover:text-fg shrink-0 text-[0.75rem] transition-colors"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void apply(l.label, null)}
                    className="text-fg-subtle hover:text-danger shrink-0 text-[0.75rem] transition-colors"
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {message && <p className="text-fg-muted mt-2 text-[0.75rem]">{message}</p>}
    </section>
  )
}
