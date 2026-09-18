import { visit, SKIP } from 'unist-util-visit'
import { normalizeSlugRef } from '@/schemas/knowledge'

/**
 * `[[some-slug]]`, the shape knowledge entries already cross-reference each
 * other with. Permissive about the separator because the corpus is: the
 * spelling is normalised when the link is built, not demanded of the author.
 */
const WIKI = /\[\[([A-Za-z0-9][A-Za-z0-9_-]{1,118}[A-Za-z0-9])\]\]/g

type TextNode = { type: 'text'; value: string }
type LinkNode = {
  type: 'link'
  url: string
  data: { hProperties: Record<string, string> }
  children: TextNode[]
}
type Parent = { type: string; children: unknown[] }

/**
 * Turns `[[slug]]` references in knowledge bodies into links.
 *
 * 268 of 377 entries carry these and nothing had ever parsed them, so they
 * rendered as literal brackets. They arrived with the claude-mem import, whose
 * own comment promised "the slug, the title, the body and the links all map
 * across without reinterpretation" — they mapped across as text, and nothing
 * was ever built to reinterpret them.
 *
 * Same shape as `remarkTaskRefs`, and for the same reason: shared memory is
 * only worth keeping if following a reference costs nothing.
 *
 * Unlike task refs there is no allowlist. A project key needs one because
 * `UTF-8` and `SHA-256` share its shape, whereas `[[...]]` is unambiguous —
 * nobody writes double brackets by accident. Where `known` is supplied, a
 * reference to something that does not exist is marked rather than dropped:
 * a dangling link that looks like a link is how 95 references to entries
 * nobody ever wrote stayed invisible.
 */
export const remarkKnowledgeRefs = ({ known }: { known?: readonly string[] } = {}) => {
  const slugs = known ? new Set(known.map(normalizeSlugRef)) : null

  return (tree: unknown) => {
    visit(
      tree as Parent,
      'text',
      (node: unknown, index: number | undefined, parent: Parent | undefined) => {
        if (!parent || index === undefined) return
        // A reference already inside a link stays as the author wrote it.
        if (parent.type === 'link' || parent.type === 'linkReference') return

        const value = (node as TextNode).value
        const out: (TextNode | LinkNode)[] = []
        let cursor = 0

        for (const match of value.matchAll(WIKI)) {
          const [full, raw] = match
          if (!raw) continue
          const slug = normalizeSlugRef(raw)
          const at = match.index
          if (at > cursor) out.push({ type: 'text', value: value.slice(cursor, at) })

          const missing = slugs ? !slugs.has(slug) : false
          out.push({
            type: 'link',
            url: `/knowledge/${slug}`,
            data: {
              hProperties: missing
                ? { 'data-knowledge-ref': slug, 'data-knowledge-missing': 'true' }
                : { 'data-knowledge-ref': slug },
            },
            // The author's spelling, not the normalised one. The link goes
            // where it should; the prose still reads as it was written.
            children: [{ type: 'text', value: raw }],
          })
          cursor = at + full.length
        }

        if (out.length === 0) return
        if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) })

        parent.children.splice(index, 1, ...out)
        // Skip past what was just inserted, or the new text nodes get rescanned.
        return [SKIP, index + out.length]
      },
    )
  }
}
