import { canDeleteSubject, type SubjectSummary } from './types'

/** The key shape `POST /projects` and promotion both take. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/

/** What a key is checked against before the server has the last word (`LAB` is the server's to refuse too). */
export const keyProblem = (key: string): string | null => {
  if (!key) return null
  if (key === 'LAB') return 'LAB is reserved for Lab subjects.'
  if (!PROJECT_KEY.test(key)) return '2–10 letters or digits, starting with a letter.'
  return null
}

const FILLER = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'with', 'vs'])

/** A starting point from the title: initials of its first words, or the head of a single word. */
export const suggestProjectKey = (title: string): string => {
  const words = title
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()))
  const first = words[0]
  if (!first) return ''
  const key = words.length === 1 ? first.slice(0, 4) : words.slice(0, 4).map((w) => w[0]).join('')
  const upper = key.toUpperCase()
  return /^[A-Z]/.test(upper) && upper.length >= 2 ? upper : ''
}

/** Who may promote, and when it makes sense: the owner or an administrator, on a live subject with no project. */
export const canPromote = (
  subject: Pick<SubjectSummary, 'owner' | 'project' | 'archived_at'>,
  viewer: { userId: string; role: 'admin' | 'member' },
) => !subject.project && !subject.archived_at && canDeleteSubject(subject, viewer)
