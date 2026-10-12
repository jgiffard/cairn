'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { mutate } from '@/lib/api/mutate'
import { keyProblem, suggestProjectKey } from './promote'

type Promoted = { project: { key: string } }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Starts a project from a subject. The dialog says what will move before it
 * does: the open todos change ref (they take numbers from the new project),
 * closed ones stay, and the subject is concluded as promoted and archived:
 * from then on the work is the project's tasks.
 *
 * `onClose` must be stable (the Escape listener is bound to it).
 */
export const PromoteSubjectDialog = ({
  subjectRef,
  subjectTitle,
  openTodos,
  onClose,
  onPromoted,
}: {
  subjectRef: string
  subjectTitle: string
  openTodos: number
  onClose: () => void
  onPromoted: (key: string) => void
}) => {
  const [key, setKey] = useState(() => suggestProjectKey(subjectTitle))
  const [title, setTitle] = useState(subjectTitle.slice(0, 200))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    keyInput.current?.focus()
    keyInput.current?.select()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const problem = keyProblem(key)
  const ready = key.length > 0 && !problem && title.trim().length > 0

  const confirm = async () => {
    if (pending || !ready) return
    setPending(true)
    setError(null)
    const result = await mutate<Promoted>(`/api/v1/subjects/${subjectRef}/promote`, {
      method: 'POST',
      body: { key, title: title.trim() },
    })
    if (result.ok) {
      onPromoted(result.data.project.key)
      return
    }
    setPending(false)
    setError(result.error)
  }

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-subject-title"
        aria-describedby="promote-subject-body"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <h2 id="promote-subject-title" className="text-ui font-semibold">
          Start a project from {subjectRef}
        </h2>
        <div id="promote-subject-body" className="text-fg-muted mt-2 flex flex-col gap-2 text-ui leading-relaxed">
          <p>
            Creates the project from {subjectRef}.
            {openTodos > 0
              ? ` Its ${plural(openTodos, 'open todo')} move${openTodos === 1 ? 's' : ''} into the project and take new refs; closed todos stay where they are.`
              : ' It has no open todos to move.'}
            {` ${subjectRef} is then concluded as promoted and archived: off the board, still searchable as the why.`}
          </p>
        </div>

        <label className="text-fg-muted mt-3 flex flex-col gap-1.5 text-meta">
          <span>Key</span>
          <Input
            ref={keyInput}
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
            autoComplete="off"
            spellCheck={false}
            maxLength={10}
            aria-invalid={Boolean(problem)}
            placeholder="ACME"
          />
          {problem ? <span className="text-danger">{problem}</span> : null}
        </label>

        <label className="text-fg-muted mt-3 flex flex-col gap-1.5 text-meta">
          <span>Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>

        {error ? (
          <p role="alert" className="text-danger mt-3 text-meta">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || pending}>
            {pending ? <Spinner /> : 'Start project'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
