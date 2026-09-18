import { describe, expect, it } from 'vitest'
import { remarkKnowledgeRefs } from './knowledge-refs'

/**
 * `[[slug]]` is how knowledge entries have always cross-referenced each other
 * — 268 of 377 use it — and nothing parsed it, so 625 references rendered as
 * literal brackets.
 *
 * The tests that matter here are the normalising one and the already-a-link
 * one: the first is the whole reason 365 references resolved to nothing, and
 * the second is how a plugin like this corrupts prose it should leave alone.
 */

type Node = { type: string; value?: string; url?: string; children?: Node[]; data?: unknown }

const run = (markdownText: string, known?: string[]): Node => {
  const tree: Node = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: markdownText }] }],
  }
  remarkKnowledgeRefs(known ? { known } : {})(tree)
  return tree
}

const links = (tree: Node): Node[] => {
  const found: Node[] = []
  const walk = (n: Node) => {
    if (n.type === 'link') found.push(n)
    n.children?.forEach(walk)
  }
  walk(tree)
  return found
}

describe('remarkKnowledgeRefs', () => {
  it('turns a reference into a link to that entry', () => {
    const [link] = links(run('See [[proxy-buffer-defaults]] for the layout.'))

    expect(link?.url).toBe('/knowledge/proxy-buffer-defaults')
  })

  it('resolves the underscore spelling to the hyphenated slug', () => {
    // The entire reason the imported graph was inert: bodies say
    // `cache_warmup_race`, every real slug is hyphenated.
    const [link] = links(run('Related: [[cache_warmup_race]]'))

    expect(link?.url).toBe('/knowledge/cache-warmup-race')
  })

  it('keeps the spelling the author used in the visible text', () => {
    // The link goes where it should; the prose still reads as written.
    const [link] = links(run('Related: [[cache_warmup_race]]'))

    expect(link?.children?.[0]?.value).toBe('cache_warmup_race')
  })

  it('leaves a reference that is already inside a link alone', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'link',
          url: 'https://example.com',
          children: [{ type: 'text', value: '[[proxy-buffer-defaults]]' }],
        },
      ],
    }
    remarkKnowledgeRefs({})(tree)

    // Still one link, still the author's — not a nested rewrite.
    expect(links(tree)).toHaveLength(1)
    expect(links(tree)[0]?.url).toBe('https://example.com')
  })

  it('handles several references in one line without losing the text between them', () => {
    const tree = run('Both [[alpha-one]] and [[beta-two]] apply here.')
    const text = (tree.children?.[0]?.children ?? []).map((n) => n.value ?? n.children?.[0]?.value)

    expect(links(tree).map((l) => l.url)).toEqual(['/knowledge/alpha-one', '/knowledge/beta-two'])
    expect(text.join('')).toBe('Both alpha-one and beta-two apply here.')
  })

  it('marks a reference to an entry that does not exist, when it can know', () => {
    const [link] = links(run('See [[never-written]].', ['proxy-buffer-defaults']))
    const props = (link?.data as { hProperties: Record<string, string> }).hProperties

    expect(props['data-knowledge-missing']).toBe('true')
  })

  it('does not mark anything when it has no list to check against', () => {
    // The knowledge list is not always to hand; an unmarked link is better
    // than one that claims an entry is missing on no evidence.
    const [link] = links(run('See [[anything-at-all]].'))
    const props = (link?.data as { hProperties: Record<string, string> }).hProperties

    expect(props['data-knowledge-missing']).toBeUndefined()
  })

  it('ignores single brackets, which are ordinary markdown', () => {
    expect(links(run('A [link](https://example.com) and [brackets].'))).toHaveLength(0)
  })

  it('ignores empty or whitespace-only brackets', () => {
    expect(links(run('Nothing here: [[]] or [[ ]].'))).toHaveLength(0)
  })
})
