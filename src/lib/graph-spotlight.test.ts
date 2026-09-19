import { describe, expect, it } from 'vitest'
import { inSpotlight, spotlightOptions } from './graph-spotlight'
import type { GraphNode } from '@/lib/api/knowledge-graph'

const node = (slug: string, project: string | null, entity: string | null): GraphNode => ({
  slug,
  title: slug,
  project,
  entity,
  degree: 1,
  island: 0,
  x: 0,
  y: 0,
})

describe('lighting up one project or world', () => {
  it('lights everything when nothing is picked', () => {
    // The resting state has to be "all of it", not "none of it" — a map that
    // starts blacked out is a map that looks broken.
    expect(inSpotlight(node('a', 'DISPOF', 'dispofi'), null)).toBe(true)
    expect(inSpotlight(node('b', null, null), null)).toBe(true)
  })

  it('lights a project without lighting its world', () => {
    const n = node('a', 'DISPOF', 'dispofi')
    expect(inSpotlight(n, { kind: 'project', key: 'DISPOF' })).toBe(true)
    expect(inSpotlight(n, { kind: 'project', key: 'BB' })).toBe(false)
  })

  it('lights a world, and every project inside it', () => {
    // The point of picking a world is that you do not have to know which of
    // its nineteen projects an entry happens to be filed against.
    const a = node('a', 'DISPOF', 'dispofi')
    const b = node('b', 'DC', 'dispofi')
    const c = node('c', 'BB', 'tribe')
    const lit = { kind: 'entity', key: 'dispofi' } as const
    expect(inSpotlight(a, lit)).toBe(true)
    expect(inSpotlight(b, lit)).toBe(true)
    expect(inSpotlight(c, lit)).toBe(false)
  })

  it('leaves an entry belonging to nothing out of every spotlight', () => {
    // 12% of the corpus carries no project at all. They are not a secret
    // group; picking any project must not light them by accident.
    const orphan = node('a', null, null)
    expect(inSpotlight(orphan, { kind: 'project', key: 'DISPOF' })).toBe(false)
    expect(inSpotlight(orphan, { kind: 'entity', key: 'dispofi' })).toBe(false)
  })

  it('offers only what is actually on the map, with counts', () => {
    // Offering every project in the instance would list dozens holding no
    // knowledge, and picking one would black the map out with no indication
    // that the answer is "nothing, yet".
    const nodes = [
      node('a', 'DISPOF', 'dispofi'),
      node('b', 'DISPOF', 'dispofi'),
      node('c', 'BB', 'tribe'),
      node('d', null, null),
    ]
    const { projects, entities } = spotlightOptions(
      nodes,
      new Map([
        ['dispofi', 'Dispofi'],
        ['tribe', 'Tribe'],
        ['unused', 'Nothing here'],
      ]),
    )

    expect(projects).toEqual([
      { key: 'BB', label: 'BB', count: 1 },
      { key: 'DISPOF', label: 'DISPOF', count: 2 },
    ])
    // Worlds are named, projects are keyed — the same split the rest of the
    // app uses, and the reason the titles are passed in at all.
    expect(entities).toEqual([
      { key: 'dispofi', label: 'Dispofi', count: 2 },
      { key: 'tribe', label: 'Tribe', count: 1 },
    ])
    expect(entities.some((e) => e.key === 'unused')).toBe(false)
  })

  it('sorts by name rather than by size', () => {
    // This is a list somebody reads down looking for one they already have in
    // mind, not a ranking.
    const nodes = [
      node('a', 'ZED', null),
      node('b', 'ALPHA', null),
      node('c', 'ALPHA', null),
      node('d', 'ALPHA', null),
    ]
    const { projects } = spotlightOptions(nodes, new Map())
    expect(projects.map((p) => p.key)).toEqual(['ALPHA', 'ZED'])
  })
})
