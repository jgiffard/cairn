import type { GraphNode } from '@/lib/api/knowledge-graph'

/**
 * One project or one world, lit against everything else.
 *
 * Cal asked whether the map should offer to GROUP by entity or by project.
 * The corpus says no to the project half of that: of a 200-entry sample, 12%
 * carry no project at all and the sizes run 61, 36, 24, 13, 10, 8 against a
 * median of three — eight of fifteen projects hold fewer than five entries.
 * Thirty-five gravitational wells over that distribution is confetti, not
 * regions, and the gathering force would have to fight the link springs much
 * harder to produce it. The links are what the page is for.
 *
 * The question underneath "group by project" is "where is my project on this
 * map", and that is a highlight. Nothing moves; the answer is better for it,
 * because you see how scattered a project's knowledge actually is against the
 * real structure rather than artificially clumped together.
 */
export type Spotlight = { kind: 'project' | 'entity'; key: string } | null

/** Whether an entry belongs to whatever is currently being picked out. */
export const inSpotlight = (node: Pick<GraphNode, 'project' | 'entity'>, lit: Spotlight): boolean =>
  !lit || (lit.kind === 'project' ? node.project === lit.key : node.entity === lit.key)

/**
 * What is actually ON the map, which is not the same as what exists.
 *
 * Offering every project in the instance would list dozens that hold no
 * knowledge at all, and picking one would black the whole map out with no
 * indication that the answer is "nothing, yet". Counted so the control can
 * say how much it is about to light up.
 */
export const spotlightOptions = (
  nodes: readonly GraphNode[],
  titles: ReadonlyMap<string, string>,
): { projects: { key: string; label: string; count: number }[]; entities: { key: string; label: string; count: number }[] } => {
  const projects = new Map<string, number>()
  const entities = new Map<string, number>()
  for (const n of nodes) {
    if (n.project) projects.set(n.project, (projects.get(n.project) ?? 0) + 1)
    if (n.entity) entities.set(n.entity, (entities.get(n.entity) ?? 0) + 1)
  }
  const shape = (m: Map<string, number>, named: boolean) =>
    [...m.entries()]
      .map(([key, count]) => ({ key, label: named ? (titles.get(key) ?? key) : key, count }))
      // By name, because this is a list somebody reads down looking for one
      // they already have in mind — not a ranking.
      .sort((a, b) => a.label.localeCompare(b.label))
  return { projects: shape(projects, false), entities: shape(entities, true) }
}
