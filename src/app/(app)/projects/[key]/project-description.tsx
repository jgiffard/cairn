'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MarkdownView } from '@/components/markdown'
import { Button, Textarea } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { cn } from '@/lib/utils'

/** Past either, the description folds to a few lines behind "Show more". */
export const COLLAPSE_CHARS = 480
export const COLLAPSE_LINES = 8

export const isLong = (text: string) =>
  text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES

/**
 * What a project is, under its header: rendered markdown, folded when long,
 * and editable in place. Agents write it with `cairn project describe`; this
 * is the same field through the same PATCH, so it records `project_described`
 * whoever changed it.
 */
export const ProjectDescription = ({
  projectId,
  description,
}: {
  projectId: string
  description: string
}) => {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The text just saved, held until the server's copy arrives, so closing the
  // editor does not flash the old description while the refresh is in flight.
  // It only applies while the prop is still what it was when saving: a
  // description rewritten by an agent afterwards must not be hidden behind it.
  const [saved, setSaved] = useState<{ from: string; text: string } | null>(null)

  const current = saved && saved.from === description ? saved.text : description
  const long = isLong(current)

  const start = () => {
    setDraft(current)
    setError(null)
    setEditing(true)
  }

  const cancel = () => {
    setEditing(false)
    setError(null)
  }

  const save = async () => {
    const text = draft.trim()
    if (text === current.trim()) {
      setEditing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await mutate(`/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        body: { description: text === '' ? null : text },
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved({ from: description, text })
      setEditing(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div>
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            }
          }}
          spellCheck
          aria-label="Project description, as markdown"
          aria-invalid={error !== null}
          placeholder="What this project is, who it is for, and how it is worked. Markdown."
          className="min-h-32 w-full [field-sizing:content] md:max-w-[75ch]"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <span className="text-fg-subtle hidden text-meta md:inline">⌘↵ save · esc cancel</span>
          {error ? <span className="text-danger text-meta">{error}</span> : null}
        </div>
      </div>
    )
  }

  if (current.trim() === '') {
    return (
      <div className="flex items-center gap-3">
        <p className="text-fg-subtle text-ui">No description.</p>
        <Button size="sm" variant="ghost" onClick={start}>
          Add one
        </Button>
      </div>
    )
  }

  const folded = long && !expanded

  return (
    <div>
      <div
        className={cn(
          'min-w-0',
          // A hard cut leaves half a line showing; the last stretch fades
          // out so the fold reads as a fold.
          folded && 'max-h-[8rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]',
          // Expanded, a very long description scrolls on its own so the task
          // list below is never pushed off the screen.
          !folded && long && 'max-h-[45dvh] overflow-y-auto',
        )}
      >
        <MarkdownView>{current}</MarkdownView>
      </div>
      {/* Pulled left by the button's own padding, so "Show more" starts under
          the text it belongs to. */}
      <div className="-ml-[calc(0.75rem+1px)] mt-1 flex items-center gap-1">
        {long ? (
          <Button size="sm" variant="quiet" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        ) : null}
        <Button size="sm" variant="quiet" onClick={start}>
          Edit
        </Button>
      </div>
    </div>
  )
}
