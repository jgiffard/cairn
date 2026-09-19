import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownView } from './markdown'
import { KnowledgeSlugsProvider } from './knowledge-slugs'

/**
 * How a reference to something nobody wrote is drawn.
 *
 * The linkifier marks these, and `remarkKnowledgeRefs` has its own tests for
 * that. What is asserted here is what the mark turns into — which used to be a
 * working link. Following it landed on the generic empty state, "That task or
 * project does not exist, or it was deleted": the wrong noun for a knowledge
 * slug, and it tells the reader the entry was lost rather than never written.
 * The tooltip says "— yet". The mark should not contradict it.
 */

const render = (body: string, known: readonly string[] | null) =>
  renderToStaticMarkup(
    <KnowledgeSlugsProvider slugs={known}>
      <MarkdownView>{body}</MarkdownView>
    </KnowledgeSlugsProvider>,
  )

describe('a knowledge reference in a body', () => {
  it('does not offer a link to an entry nobody has written', () => {
    const html = render('see [[never-written]] for context', ['something-else'])

    expect(html).toContain('never-written')
    expect(html).not.toContain('href="/knowledge/never-written"')
  })

  it('still says what it is, and that it could yet exist', () => {
    const html = render('see [[never-written]] for context', ['something-else'])

    expect(html).toContain('No knowledge')
    expect(html).toContain('decoration-dotted')
    // A pointer promising a destination was part of what made it read as a
    // working link.
    expect(html).toContain('cursor-help')
  })

  it('leaves a reference that does resolve as a link', () => {
    const html = render('see [[written-down]] for context', ['written-down'])

    expect(html).toContain('href="/knowledge/written-down"')
    expect(html).toContain('text-accent')
    expect(html).not.toContain('cursor-help')
  })

  it('marks nothing at all when the slug list is unknown', () => {
    // The provider's default is null rather than [], and the difference is the
    // whole point: an empty list means "nothing exists" and would paint every
    // reference on the page as broken.
    const html = render('see [[written-down]] for context', null)

    expect(html).toContain('href="/knowledge/written-down"')
    expect(html).not.toContain('cursor-help')
  })
})
