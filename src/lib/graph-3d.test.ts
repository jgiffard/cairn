import { describe, expect, it } from 'vitest'
import { layout3D } from './graph-3d'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The flat map's contract is that the picture is identical between renders, so
 * a `router.refresh()` landing after an agent writes a note cannot make it
 * jump. Lifting it into three dimensions keeps that contract or gives up the
 * only reason the layout is computed on the server in the first place — and a
 * relaxation is exactly the kind of code that quietly stops being
 * deterministic, so it is pinned here rather than trusted.
 */

const node = (slug: string, degree: number, i: number) => ({
  slug,
  title: slug,
  project: null,
  degree,
  island: degree > 0 ? 0 : -1,
  x: i * 17,
  y: (i % 5) * 23,
})

const graph = (over: Partial<KnowledgeGraph> = {}): KnowledgeGraph => {
  const nodes = [
    node('alpha', 3, 0),
    node('beta', 2, 1),
    node('gamma', 2, 2),
    node('delta', 1, 3),
    node('lonely', 0, 4),
    node('adrift', 0, 5),
  ]
  return {
    nodes,
    edges: [
      { source: 'alpha', target: 'beta' },
      { source: 'alpha', target: 'gamma' },
      { source: 'beta', target: 'gamma' },
      { source: 'alpha', target: 'delta' },
    ],
    missing: [{ slug: 'never-written', from: ['alpha'], x: 5, y: 5 }],
    islands: [4],
    width: 100,
    height: 100,
    isolatedFrom: 4,
    stats: {
      entries: 6,
      withReferences: 4,
      references: 5,
      resolved: 4,
      dangling: 1,
      isolated: 2,
      islands: 1,
    },
    ...over,
  }
}

describe('the map in three dimensions', () => {
  it('puts the same corpus in the same place every time', () => {
    // Not "close enough": exactly. A relaxation that converges to a tolerance
    // rather than a fixed iteration count drifts with floating-point noise,
    // and the map would then move a little on every refresh.
    const a = layout3D(graph())
    const b = layout3D(graph())

    expect([...a.at.keys()].sort()).toEqual([...b.at.keys()].sort())
    for (const [slug, p] of a.at) {
      expect(b.at.get(slug)).toEqual(p)
    }
    expect(a.radius).toBe(b.radius)
    expect(a.floor).toBe(b.floor)
  })

  it('does not depend on the order the entries arrive in', () => {
    // The rows come back from Postgres in whatever order the planner chose.
    // Positions keyed off the index rather than the slug would move the whole
    // cloud when one entry was edited and its `updated_at` changed.
    const forward = layout3D(graph())
    const reversed = layout3D(graph({ nodes: [...graph().nodes].reverse() }))

    for (const [slug, p] of forward.at) {
      const other = reversed.at.get(slug)
      expect(other).toBeDefined()
      // Same seed, same forces, same answer — the relaxation is symmetric in
      // its inputs, so this is equality and not a tolerance either.
      expect(other?.x).toBeCloseTo(p.x, 6)
      expect(other?.y).toBeCloseTo(p.y, 6)
      expect(other?.z).toBeCloseTo(p.z, 6)
    }
  })

  it('never produces a coordinate that cannot be drawn', () => {
    // One NaN puts a sphere at the origin and a link across the whole scene,
    // and nothing reports it. Division by a zero distance is the way in, so
    // two entries on exactly the same point are the case that matters.
    const stacked = graph({
      nodes: graph().nodes.map((n) => ({ ...n, x: 0, y: 0 })),
    })
    const place = layout3D(stacked)

    for (const [slug, p] of place.at) {
      expect(Number.isFinite(p.x), `${slug}.x`).toBe(true)
      expect(Number.isFinite(p.y), `${slug}.y`).toBe(true)
      expect(Number.isFinite(p.z), `${slug}.z`).toBe(true)
    }
    expect(Number.isFinite(place.radius)).toBe(true)
  })

  it('keeps the entries joined to nothing below everything else', () => {
    // This is the whole answer to the objection against drawing the map in 3D:
    // depth hides things behind other things, and how much of the corpus is
    // joined to nothing is the one finding the page exists to deliver. On a
    // plane of their own, under the cloud, they stay countable from any angle
    // the camera is allowed to reach.
    const place = layout3D(graph())
    const connected = ['alpha', 'beta', 'gamma', 'delta']
    const orphans = ['lonely', 'adrift']

    const lowestConnected = Math.min(...connected.map((s) => place.at.get(s)?.y ?? Infinity))
    for (const slug of orphans) {
      expect(place.at.get(slug)?.y).toBeLessThan(lowestConnected)
    }
  })

  it('spreads the orphans over a disc rather than stacking them', () => {
    // They have no links, so any structure the eye finds in them would be a
    // lie — but they still have to be individually visible to be counted.
    const many = {
      ...graph(),
      nodes: [
        ...graph().nodes.filter((n) => n.degree > 0),
        ...Array.from({ length: 40 }, (_, i) => node(`orphan-${i}`, 0, i)),
      ],
    }
    const place = layout3D(many)
    const points = Array.from({ length: 40 }, (_, i) => place.at.get(`orphan-${i}`))

    expect(points.every(Boolean)).toBe(true)
    // All on one plane...
    const ys = new Set(points.map((p) => p?.y))
    expect(ys.size).toBe(1)
    // ...and no two in the same spot.
    const spots = new Set(points.map((p) => `${p?.x.toFixed(4)},${p?.z.toFixed(4)}`))
    expect(spots.size).toBe(40)
  })

  it('hangs a never-written reference off whatever cited it', () => {
    // Dropped at a random offset it lands inside the cluster it belongs to and
    // reads as one of its members, which is the opposite of the point.
    const place = layout3D(graph())
    const anchor = place.at.get('alpha')
    const stub = place.at.get('never-written')

    expect(stub).toBeDefined()
    expect(anchor).toBeDefined()
    const gap = Math.hypot(
      (stub?.x ?? 0) - (anchor?.x ?? 0),
      (stub?.y ?? 0) - (anchor?.y ?? 0),
      (stub?.z ?? 0) - (anchor?.z ?? 0),
    )
    expect(gap).toBeGreaterThan(0)
    // Near its anchor, not across the scene from it.
    expect(gap).toBeLessThan(place.radius)
  })

  it('draws a corpus with nothing joined to anything', () => {
    // A new install, and the case where the relaxation has no edges to run on.
    const place = layout3D(
      graph({
        nodes: [node('lonely', 0, 0), node('adrift', 0, 1)],
        edges: [],
        missing: [],
        isolatedFrom: 0,
      }),
    )

    expect(place.at.size).toBe(2)
    for (const p of place.at.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
    }
  })

  it('draws an empty corpus without dividing by it', () => {
    const place = layout3D(
      graph({ nodes: [], edges: [], missing: [], islands: [], isolatedFrom: 0 }),
    )

    expect(place.at.size).toBe(0)
    expect(Number.isFinite(place.radius)).toBe(true)
    expect(place.radius).toBeGreaterThan(0)
  })

  it('pulls linked entries closer than unlinked ones', () => {
    // The relaxation has to actually do something. Without this the test suite
    // would pass on a layout that returned the seed unchanged.
    const place = layout3D(graph())
    const d = (a: string, b: string) => {
      const p = place.at.get(a)
      const q = place.at.get(b)
      return Math.hypot((p?.x ?? 0) - (q?.x ?? 0), (p?.y ?? 0) - (q?.y ?? 0), (p?.z ?? 0) - (q?.z ?? 0))
    }

    // alpha-beta-gamma are a triangle; delta hangs off alpha alone.
    expect(d('alpha', 'beta')).toBeLessThan(place.radius * 2)
    expect(d('beta', 'gamma')).toBeLessThan(place.radius * 2)
  })
})
