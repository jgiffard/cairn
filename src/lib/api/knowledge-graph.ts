import { admin } from '@/lib/db/client'
import { normalizeSlugRef } from '@/schemas/knowledge'
import { components, layoutGraph, type Edge } from '@/lib/graph-layout'

/**
 * The knowledge corpus as a map, including the parts of it joined to nothing.
 *
 * Every other view here answers "what is connected to this". None answers
 * "what is connected to nothing", and that turned out to be the question worth
 * asking: of 377 entries, 105 have no reference in or out, they fall into
 * nineteen separate islands, and 31 references point at entries nobody ever
 * wrote. All of it was invisible, because absence does not appear in a list —
 * a list shows what is there.
 *
 * The edges live in prose rather than in a table. `[[some-slug]]` is how these
 * entries have always cross-referenced each other, so this reads them out of
 * the bodies with the same regex the renderer uses. Extracting them here, once
 * and on the server, also produces the one thing the renderer never had: the
 * complete set of slugs that exist, which is what lets a reference to
 * something unwritten be MARKED rather than silently linked into the void.
 */

/** The same shape `remarkKnowledgeRefs` matches, and deliberately the same. */
const WIKI = /\[\[([A-Za-z0-9][A-Za-z0-9_-]{1,118}[A-Za-z0-9])\]\]/g

/**
 * A fenced block is code, not prose.
 *
 * The renderer never linkifies inside one because the markdown parser hands it
 * a `code` node instead of text. Reading raw bodies has no such help, so a
 * `[[slug]]` shown as an EXAMPLE inside a fence would otherwise become a real
 * edge on the map — a graph slightly denser than the prose it claims to draw.
 */
const withoutFences = (body: string): string => body.replace(/```[\s\S]*?```/g, ' ')

export const referencesIn = (body: string): string[] => {
  const found = new Set<string>()
  for (const [, raw] of withoutFences(body).matchAll(WIKI)) {
    if (raw) found.add(normalizeSlugRef(raw))
  }
  return [...found]
}

export type GraphNode = {
  slug: string
  title: string
  project: string | null
  /** How many entries this one is joined to, in either direction. */
  degree: number
  /** Index into `islands`; -1 for an entry joined to nothing. */
  island: number
  x: number
  y: number
}

/** A reference to an entry nobody ever wrote. Drawn, not dropped. */
export type MissingNode = {
  slug: string
  /** The entries that point at it. */
  from: string[]
  x: number
  y: number
}

export type KnowledgeGraph = {
  nodes: GraphNode[]
  edges: { source: string; target: string }[]
  missing: MissingNode[]
  islands: number[]
  width: number
  height: number
  isolatedFrom: number
  stats: {
    entries: number
    withReferences: number
    references: number
    resolved: number
    dangling: number
    isolated: number
    islands: number
  }
}

type Row = {
  slug: string
  title: string
  body: string
  knowledge_projects?: { project?: { key?: string } | null }[]
}

/**
 * Every slug in the store, which is the set the renderer needs and has never
 * had.
 *
 * `markdown.tsx` passes no `known` list, so `remarkKnowledgeRefs` links every
 * reference whether or not its target exists — CAIRN-192 left it that way
 * because the only list to hand was a page capped at 300 against a corpus of
 * 377, and using it would have marked 77 real entries as missing. This is the
 * whole set and nothing else: one column, no bodies.
 */
export const knownSlugs = async (): Promise<string[]> => {
  const { data, error } = await admin().from('knowledge').select('slug')
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => normalizeSlugRef(row.slug as string))
}

export const knowledgeGraph = async (): Promise<KnowledgeGraph> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select('slug, title, body, knowledge_projects(project:projects(key))')
    .is('superseded_by', null)
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as unknown as Row[]
  const bySlug = new Map(rows.map((row) => [normalizeSlugRef(row.slug), row]))

  const edges: Edge[] = []
  const seen = new Set<string>()
  const missing = new Map<string, string[]>()
  const degree = new Map<string, number>()
  let references = 0
  let resolved = 0
  let withReferences = 0

  for (const row of rows) {
    const from = normalizeSlugRef(row.slug)
    const refs = referencesIn(row.body ?? '')
    if (refs.length > 0) withReferences += 1

    for (const to of refs) {
      references += 1
      // An entry referencing itself is not connected to anything by that.
      if (to === from) continue

      if (!bySlug.has(to)) {
        missing.set(to, [...(missing.get(to) ?? []), from])
        continue
      }
      resolved += 1

      // Undirected: two entries that cite each other are one link, not two.
      const key = [from, to].sort().join(' -> ')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: from, target: to })
      degree.set(from, (degree.get(from) ?? 0) + 1)
      degree.set(to, (degree.get(to) ?? 0) + 1)
    }
  }

  const ids = [...bySlug.keys()].sort()
  const { placed, width, height, isolatedFrom } = layoutGraph(ids, edges)

  const islandOf = new Map<string, number>()
  const islands: number[] = []
  components(ids, edges)
    .filter((group) => group.length > 1)
    .forEach((group, index) => {
      islands.push(group.length)
      for (const id of group) islandOf.set(id, index)
    })

  const nodes: GraphNode[] = placed.map((p) => {
    const row = bySlug.get(p.id) as Row
    const key = row.knowledge_projects?.[0]?.project?.key ?? null
    return {
      slug: p.id,
      title: row.title,
      project: key,
      degree: degree.get(p.id) ?? 0,
      island: islandOf.get(p.id) ?? -1,
      x: p.x,
      y: p.y,
    }
  })

  /**
   * A missing target is drawn beside whichever entry points at it, so the gap
   * appears where the reader already is rather than in a list somewhere else.
   * It has no position of its own — it does not exist — so it borrows one.
   */
  const at = new Map(nodes.map((node) => [node.slug, node]))
  const missingNodes: MissingNode[] = [...missing.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([slug, from], i) => {
      const anchor = at.get(from[0] as string)
      const angle = (i / Math.max(1, missing.size)) * Math.PI * 2
      return {
        slug,
        from,
        x: (anchor?.x ?? 0) + Math.cos(angle) * 46,
        y: (anchor?.y ?? 0) + Math.sin(angle) * 46,
      }
    })

  const dangling = [...missing.values()].reduce((total, from) => total + from.length, 0)

  return {
    nodes,
    edges,
    missing: missingNodes,
    islands,
    width,
    height,
    isolatedFrom,
    stats: {
      entries: rows.length,
      withReferences,
      references,
      resolved,
      dangling,
      isolated: nodes.length - isolatedFrom,
      islands: islands.length,
    },
  }
}
