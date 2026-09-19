import { unstable_cache } from 'next/cache'
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
  /**
   * The world this entry belongs to: a business, a stack, a subsystem.
   *
   * Thirty-five project keys is more colours than anyone can hold, and the
   * grouping a reader actually thinks in sits one level up — "the Dispofi
   * side", "the Tribe side". Carried here so the map can show it.
   *
   * Taken from the entry's own entity scope where it has one, and otherwise
   * inherited from its project. An entry filed against `dispofi-api` belongs
   * to the Dispofi world whether or not anybody said so, and making that
   * explicit on every row is work nobody would keep up.
   */
  entity: string | null
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
  superseded_by?: string | null
  knowledge_projects?: { project?: { key?: string } | null }[]
  knowledge_entities?: { entity?: { key?: string } | null }[]
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

/**
 * The graph itself, without anywhere to draw it.
 *
 * Split out because the findings are worth more than the picture: what is
 * joined to nothing, what is referenced but never written, how many separate
 * islands there are. A browser needs coordinates; an agent needs the facts,
 * and should not pay for a force simulation to get them.
 */
export type KnowledgeGaps = {
  /** Entries with no reference in or out. */
  orphans: { slug: string; title: string; project: string | null }[]
  /** Referenced, never written. */
  missing: { slug: string; from: string[] }[]
  /** Sizes of the connected components, largest first. */
  islands: number[]
  stats: KnowledgeGraph['stats']
}

type Analysed = {
  rows: Row[]
  bySlug: Map<string, Row>
  edges: Edge[]
  degree: Map<string, number>
  missing: Map<string, string[]>
  references: number
  resolved: number
  withReferences: number
}

const analyse = async (): Promise<Analysed> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select('slug, title, body, superseded_by, knowledge_projects(project:projects(key)), knowledge_entities(entity:entities(key))')
  if (error) throw new Error(error.message)

  const all = (data ?? []) as unknown as Row[]

  /**
   * A superseded entry is not drawn, and is not missing either.
   *
   * It still exists: `getKnowledge` resolves it, the renderer links it, and a
   * reader following the reference lands on the page. Excluding it from the
   * lookup as well as from the drawing made every reference to a corrected
   * entry count as "referenced, but never written" — the map contradicting the
   * page it is a map of, and inflating the one headline the page exists for.
   */
  const rows = all.filter((row) => !row.superseded_by)
  const exists = new Set(all.map((row) => normalizeSlugRef(row.slug)))
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

      if (!exists.has(to)) {
        missing.set(to, [...(missing.get(to) ?? []), from])
        continue
      }
      resolved += 1

      // Real, and deliberately not on the map: an edge to a node that is not
      // drawn would be a line to nowhere.
      if (!bySlug.has(to)) continue

      // Undirected: two entries that cite each other are one link, not two.
      const key = [from, to].sort().join(' -> ')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: from, target: to })
      degree.set(from, (degree.get(from) ?? 0) + 1)
      degree.set(to, (degree.get(to) ?? 0) + 1)
    }
  }

  return { rows, bySlug, edges, degree, missing, references, resolved, withReferences }
}

/**
 * One project key for a row, chosen the same way every time.
 *
 * The embedded aggregate comes back without an ORDER BY, so `[0]` is whatever
 * order the scan happened to produce — not stable across an update or a vacuum.
 */
const projectKeyOf = (row: Row): string | null =>
  (row.knowledge_projects ?? [])
    .map((link) => link.project?.key)
    .filter((key): key is string => Boolean(key))
    .sort()[0] ?? null

/** Its own entity scope, if it was given one. Sorted for the same reason. */
const entityKeyOf = (row: Row): string | null =>
  (row.knowledge_entities ?? [])
    .map((link) => link.entity?.key)
    .filter((key): key is string => Boolean(key))
    .sort()[0] ?? null

/**
 * Which world each project belongs to.
 *
 * Read once and joined in memory rather than as a third level of embedded
 * select: there are thirty-five projects and five entities, so this is two
 * small queries against a join that would otherwise be nested three deep in a
 * client that has never been asked to do that.
 */
const entityByProject = async (): Promise<Map<string, string>> => {
  const { data, error } = await admin()
    .from('project_entities')
    .select('project:projects(key), entity:entities(key)')
  if (error) throw new Error(error.message)
  const out = new Map<string, string>()
  for (const row of (data ?? []) as unknown as {
    project?: { key?: string } | { key?: string }[] | null
    entity?: { key?: string } | { key?: string }[] | null
  }[]) {
    const p = Array.isArray(row.project) ? row.project[0]?.key : row.project?.key
    const e = Array.isArray(row.entity) ? row.entity[0]?.key : row.entity?.key
    // A project can belong to more than one entity. First by name wins, so
    // the answer does not depend on scan order.
    if (p && e && (!out.has(p) || (out.get(p) as string) > e)) out.set(p, e)
  }
  return out
}

/** Counts that do not depend on where anything is drawn. */
const summarise = (a: Analysed, isolated: number, islands: number[]): KnowledgeGraph['stats'] => ({
  entries: a.rows.length,
  withReferences: a.withReferences,
  references: a.references,
  resolved: a.resolved,
  dangling: [...a.missing.values()].reduce((total, from) => total + from.length, 0),
  isolated,
  islands: islands.length,
})

const islandsOf = (ids: string[], edges: Edge[]): { sizes: number[]; of: Map<string, number> } => {
  const of = new Map<string, number>()
  const sizes: number[] = []
  components(ids, edges)
    .filter((group) => group.length > 1)
    .forEach((group, index) => {
      sizes.push(group.length)
      for (const id of group) of.set(id, index)
    })
  return { sizes, of }
}

/**
 * What the map shows, for a reader who has no screen.
 *
 * Cairn is agent-facing and these findings were visible only in a browser:
 * the entries that wrote themselves into a corner, and the references pointing
 * at things nobody ever wrote. An agent that cannot see them cannot fix them.
 */
export const knowledgeGaps = async (): Promise<KnowledgeGaps> => {
  const a = await analyse()
  const ids = [...a.bySlug.keys()].sort()
  const { sizes, of } = islandsOf(ids, a.edges)

  const orphans = ids
    .filter((id) => !of.has(id))
    .map((id) => {
      const row = a.bySlug.get(id) as Row
      return { slug: id, title: row.title, project: projectKeyOf(row) }
    })

  return {
    orphans,
    missing: [...a.missing.entries()]
      .map(([slug, from]) => ({ slug, from: [...new Set(from)].sort() }))
      .sort((x, y) => y.from.length - x.from.length || x.slug.localeCompare(y.slug)),
    islands: sizes,
    stats: summarise(a, orphans.length, sizes),
  }
}

/**
 * Whether the corpus has changed at all, in one cheap query.
 *
 * The map is `force-dynamic`, and every open tab re-renders it through
 * `router.refresh()` each time the live stream reports a change — which while
 * agents are working is every four seconds. Without this each of those tabs
 * paid a full fetch of every body plus a force simulation for a picture that
 * had not moved. This is the one query worth running every time; everything
 * behind it is keyed on the answer.
 */
const corpusVersion = async (): Promise<string> => {
  const { data, error } = await admin().from('knowledge').select('updated_at')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as { updated_at: string }[]
  const latest = rows.reduce((newest, row) => (row.updated_at > newest ? row.updated_at : newest), '')
  return `${rows.length}:${latest}`
}

const graphFor = unstable_cache(
  async (_version: string): Promise<KnowledgeGraph> => buildGraph(),
  ['cairn-knowledge-graph'],
  { revalidate: 3600 },
)

export const knowledgeGraph = async (): Promise<KnowledgeGraph> => graphFor(await corpusVersion())

const buildGraph = async (): Promise<KnowledgeGraph> => {
  const [a, worldOf] = await Promise.all([analyse(), entityByProject()])
  const { rows, bySlug, edges, degree, missing } = a

  const ids = [...bySlug.keys()].sort()
  const { placed, width, height, isolatedFrom } = layoutGraph(ids, edges)

  const { sizes: islands, of: islandOf } = islandsOf(ids, edges)

  const nodes: GraphNode[] = placed.map((p) => {
    const row = bySlug.get(p.id) as Row
    // Sorted, because the embedded aggregate has no ORDER BY: taking [0] of a
    // scan order that is not stable would change a dot's colour between two
    // renders of the same corpus, which is the one thing this must not do.
    const key = projectKeyOf(row)
    return {
      slug: p.id,
      title: row.title,
      project: key,
      // Its own scope first, then whatever world its project lives in.
      entity: entityKeyOf(row) ?? (key ? (worldOf.get(key) ?? null) : null),
      degree: degree.get(p.id) ?? 0,
      island: islandOf.get(p.id) ?? -1,
      // One decimal. Nothing is drawn to a tenth of a unit, and full float
      // precision was shipping `87.6812408671319` per node twice over.
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
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
        x: Math.round(((anchor?.x ?? 0) + Math.cos(angle) * 46) * 10) / 10,
        y: Math.round(((anchor?.y ?? 0) + Math.sin(angle) * 46) * 10) / 10,
      }
    })

  return {
    nodes,
    edges,
    missing: missingNodes,
    islands,
    width,
    height,
    isolatedFrom,
    stats: summarise(a, nodes.length - isolatedFrom, islands),
  }
}
