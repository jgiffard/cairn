import { Fragment } from 'react'

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The words of a query worth marking in a result: two characters or more,
 * trimmed of surrounding punctuation, longest first so that "debugger" is
 * marked whole rather than as "debug" plus a tail.
 */
export const queryTerms = (query: string): string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter((t) => t.length >= 2),
    ),
  ].sort((a, b) => b.length - a.length)

/**
 * The text with each query term lit: a soft wash of the accent and a
 * hairline under it, so the eye finds why a row matched without the row
 * turning into a page of yellow.
 */
export const Highlight = ({ text, terms }: { text: string; terms: string[] }) => {
  if (!text || terms.length === 0) return <>{text}</>
  const parts = text.split(new RegExp(`(${terms.map(escape).join('|')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="bg-accent-subtle text-fg rounded-[3px] box-decoration-clone px-[1px] shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--accent)_45%,transparent)]"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}
