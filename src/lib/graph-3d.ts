import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * Where the map goes when it stops being flat.
 *
 * The 2D layout arrives from the server and is the contract everything else
 * relies on: identical between renders, so a `router.refresh()` landing after
 * an agent writes a note cannot make the picture jump. This keeps that
 * contract. There is no `Math.random` anywhere below, the relaxation runs a
 * fixed number of iterations rather than to a tolerance, and every seed comes
 * from the same slug hash the palette and the 2D layout already use. Same
 * corpus in, same cloud out, on every machine.
 *
 * The relaxation is worth the ~40ms it costs. Lifting the flat layout straight
 * up — x and y kept, z from a hash — gives you a picture that is technically
 * three-dimensional and reads as a flat map with jitter, because the structure
 * is still entirely in two of the axes. Letting the islands find their own
 * shape in all three is what makes the depth mean something: clusters become
 * volumes you can orbit rather than discs you are looking at edge-on.
 *
 * The entries joined to nothing do NOT take part. They sit on a flat disc
 * below the cloud, in a deterministic spiral. That is deliberate and it is the
 * whole answer to the objection against drawing this in 3D at all: depth hides
 * things behind other things, and the one thing this page exists to show is
 * how much of the corpus is joined to nothing. On a plane of their own, under
 * everything else, they stay countable from any angle the camera can reach.
 */

/** Deterministic, and the same hash the layout and the palette use. */
const hash = (key: string): number => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}

/** A hashed value in [0, 1), from an independent stream per axis. */
const unit = (key: string, salt: number): number => ((hash(key) ^ (salt * 0x9e3779b1)) >>> 0) / 4294967296

export type Point3 = { x: number; y: number; z: number }

export type Layout3D = {
  /** Connected entries, and the stubs for entries nobody wrote. */
  at: Map<string, Point3>
  /** Roughly the radius of the connected cloud, for framing the camera. */
  radius: number
  /** The plane the joined-to-nothing sit on, below everything else. */
  floor: number
  /**
   * Where each world ended up, and how big it is.
   *
   * The scene draws a name and a soft volume at each of these. Computed here
   * rather than there because it is the layout that knows where anything is,
   * and because a centroid taken after the relaxation is the honest answer to
   * "where is Dispofi" — not a guess made from the seed.
   */
  worlds: { key: string; x: number; y: number; z: number; spread: number; count: number }[]
}

/** How far apart the cloud wants to be, before anything is drawn in it. */
const SPREAD = 100

/**
 * Fixed, not "until it settles".
 *
 * A tolerance makes the result depend on floating-point noise and on how many
 * nodes happen to be in the corpus that day, which is exactly the kind of
 * thing that moves a map between two renders of the same data.
 */
const ITERATIONS = 90

export const layout3D = (graph: KnowledgeGraph): Layout3D => {
  /**
   * Sorted, and that is not cosmetic.
   *
   * The rows arrive in whatever order Postgres chose, which changes when an
   * entry is edited and its `updated_at` moves. Floating-point addition is not
   * associative, so summing the same forces in a different order gives a
   * slightly different answer — and "slightly" compounds over ninety
   * iterations into a visibly different cloud. Fixing the order fixes the
   * arithmetic, and the map stops depending on which row the planner happened
   * to return first.
   */
  const byName = (a: { slug: string }, b: { slug: string }) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  const connected = graph.nodes.filter((n) => n.degree > 0).sort(byName)
  const isolated = graph.nodes.filter((n) => n.degree === 0).sort(byName)
  const at = new Map<string, Point3>()

  const index = new Map(connected.map((n, i) => [n.slug, i]))
  const count = connected.length

  // Flat arrays rather than objects: this is the only hot loop on the page and
  // it runs 90 times over every pair.
  const px = new Float64Array(count)
  const py = new Float64Array(count)
  const pz = new Float64Array(count)
  const fx = new Float64Array(count)
  const fy = new Float64Array(count)
  const fz = new Float64Array(count)

  // The flat layout's own extent, so the seed is scaled to the cloud rather
  // than to whatever coordinate space the server happened to use.
  const xs = connected.map((n) => n.x)
  const ys = connected.map((n) => n.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(1, Math.max(...xs) - minX)
  const spanY = Math.max(1, Math.max(...ys) - minY)

  for (let i = 0; i < count; i += 1) {
    const n = connected[i]
    if (!n) continue
    // Seeded FROM the flat layout, not from nothing. The server has already
    // done the work of pulling islands apart; starting from a random cloud
    // throws that away and lets the relaxation find a different, equally valid
    // arrangement every time the corpus changes by one entry.
    px[i] = ((n.x - minX) / spanX - 0.5) * SPREAD * 2
    py[i] = ((n.y - minY) / spanY - 0.5) * SPREAD * 2
    pz[i] = (unit(n.slug, 1) - 0.5) * SPREAD * 1.2
  }

  // Edges as index pairs, resolved once rather than through the map 90 times.
  const ea: number[] = []
  const eb: number[] = []
  for (const { source, target } of graph.edges) {
    const a = index.get(source)
    const b = index.get(target)
    if (a === undefined || b === undefined) continue
    ea.push(a)
    eb.push(b)
  }

  const repulsion = SPREAD * SPREAD * 0.9
  const rest = SPREAD * 0.22

  /**
   * Which world each node belongs to, as an index.
   *
   * Entries sharing an entity are pulled toward their own shared centre, on
   * top of whatever their links are doing. Links alone give you islands;
   * islands alone do not tell you that nineteen of the thirty-five projects
   * are the same business. The pull is deliberately weaker than the springs —
   * it should gather the worlds into regions, not drag two genuinely linked
   * entries apart to sit with their own kind.
   */
  const worldKeys = [...new Set(connected.map((n) => n.entity).filter((e): e is string => Boolean(e)))].sort()
  const worldOf = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i += 1) {
    const e = connected[i]?.entity
    if (e) worldOf[i] = worldKeys.indexOf(e)
  }
  const worldN = worldKeys.length
  const wx = new Float64Array(worldN)
  const wy = new Float64Array(worldN)
  const wz = new Float64Array(worldN)
  const wc = new Float64Array(worldN)
  const GATHER = 0.035

  // Skipped entirely when there is nothing to relax. A corpus where no entry
  // references another is not a broken corpus — it is a new install, and it
  // still has to draw. Returning early here instead left the orphans and the
  // never-written stubs unplaced, so the map came back empty.
  for (let step = 0; count > 0 && step < ITERATIONS; step += 1) {
    fx.fill(0)
    fy.fill(0)
    fz.fill(0)

    // Everything pushes everything else apart, which is what stops the
    // clusters collapsing into one another and gives the cloud its volume.
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = (px[i] as number) - (px[j] as number)
        let dy = (py[i] as number) - (py[j] as number)
        let dz = (pz[i] as number) - (pz[j] as number)
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 < 0.01) {
          // Two entries on exactly the same point have no direction to
          // separate along. Nudge them apart deterministically rather than
          // dividing by nothing.
          // Keyed off the slugs, not the indices: an index-keyed nudge is a
          // different nudge the moment the rows come back in another order.
          const pair = `${connected[i]?.slug ?? i}:${connected[j]?.slug ?? j}`
          dx = unit(pair, 2) - 0.5
          dy = unit(pair, 3) - 0.5
          dz = unit(pair, 4) - 0.5
          d2 = 0.01
        }
        const force = repulsion / d2
        const d = Math.sqrt(d2)
        const ux = (dx / d) * force
        const uy = (dy / d) * force
        const uz = (dz / d) * force
        fx[i] = (fx[i] as number) + ux
        fy[i] = (fy[i] as number) + uy
        fz[i] = (fz[i] as number) + uz
        fx[j] = (fx[j] as number) - ux
        fy[j] = (fy[j] as number) - uy
        fz[j] = (fz[j] as number) - uz
      }
    }

    // Each world gathers toward its own centre of mass, recomputed every
    // step so the regions form rather than being decided in advance.
    if (worldN > 0) {
      wx.fill(0); wy.fill(0); wz.fill(0); wc.fill(0)
      for (let i = 0; i < count; i += 1) {
        const w = worldOf[i] as number
        if (w < 0) continue
        wx[w] = (wx[w] as number) + (px[i] as number)
        wy[w] = (wy[w] as number) + (py[i] as number)
        wz[w] = (wz[w] as number) + (pz[i] as number)
        wc[w] = (wc[w] as number) + 1
      }
      for (let i = 0; i < count; i += 1) {
        const w = worldOf[i] as number
        if (w < 0 || (wc[w] as number) < 2) continue
        const n = wc[w] as number
        fx[i] = (fx[i] as number) + (((wx[w] as number) / n) - (px[i] as number)) * GATHER * repulsion * 0.0004
        fy[i] = (fy[i] as number) + (((wy[w] as number) / n) - (py[i] as number)) * GATHER * repulsion * 0.0004
        fz[i] = (fz[i] as number) + (((wz[w] as number) / n) - (pz[i] as number)) * GATHER * repulsion * 0.0004
      }
    }

    // And links pull their two ends together.
    for (let e = 0; e < ea.length; e += 1) {
      const i = ea[e] as number
      const j = eb[e] as number
      const dx = (px[j] as number) - (px[i] as number)
      const dy = (py[j] as number) - (py[i] as number)
      const dz = (pz[j] as number) - (pz[i] as number)
      const d = Math.hypot(dx, dy, dz) || 1
      const pull = (d - rest) * 0.06
      const ux = (dx / d) * pull
      const uy = (dy / d) * pull
      const uz = (dz / d) * pull
      fx[i] = (fx[i] as number) + ux
      fy[i] = (fy[i] as number) + uy
      fz[i] = (fz[i] as number) + uz
      fx[j] = (fx[j] as number) - ux
      fy[j] = (fy[j] as number) - uy
      fz[j] = (fz[j] as number) - uz
    }

    // Cooling, so the early steps move things a long way and the late ones
    // only tidy. Without it the last iteration is as violent as the first and
    // the result depends on where it happened to stop.
    const heat = 0.9 * (1 - step / ITERATIONS) ** 1.4 + 0.04
    for (let i = 0; i < count; i += 1) {
      // Pulled gently home, or the repulsion inflates the cloud without limit
      // and the islands drift off the far side of the camera.
      const gravity = 0.012
      const vx = (fx[i] as number) * heat - (px[i] as number) * gravity
      const vy = (fy[i] as number) * heat - (py[i] as number) * gravity
      const vz = (fz[i] as number) * heat - (pz[i] as number) * gravity
      // Clamped: one very close pair produces an enormous force, and a node
      // thrown across the scene in a single step never comes back.
      const limit = SPREAD * 0.35
      const speed = Math.hypot(vx, vy, vz)
      const k = speed > limit ? limit / speed : 1
      px[i] = (px[i] as number) + vx * k
      py[i] = (py[i] as number) + vy * k
      pz[i] = (pz[i] as number) + vz * k
    }
  }

  let radius = SPREAD
  for (let i = 0; i < count; i += 1) {
    const n = connected[i]
    if (!n) continue
    const p = { x: px[i] as number, y: py[i] as number, z: pz[i] as number }
    at.set(n.slug, p)
    radius = Math.max(radius, Math.hypot(p.x, p.y, p.z))
  }

  /**
   * Where each world settled, and how far it reaches.
   *
   * `spread` is the mean distance of a world's members from their own centre,
   * which is what the scene sizes its volume and its name from. A maximum
   * would be dominated by the one outlier every cluster has.
   */
  const worlds: Layout3D['worlds'] = worldKeys.map((key, w) => {
    let sx = 0, sy = 0, sz = 0, n = 0
    for (let i = 0; i < count; i += 1) {
      if ((worldOf[i] as number) !== w) continue
      sx += px[i] as number; sy += py[i] as number; sz += pz[i] as number; n += 1
    }
    if (n === 0) return { key, x: 0, y: 0, z: 0, spread: SPREAD, count: 0 }
    const cx = sx / n, cy = sy / n, cz = sz / n
    let d = 0
    for (let i = 0; i < count; i += 1) {
      if ((worldOf[i] as number) !== w) continue
      d += Math.hypot((px[i] as number) - cx, (py[i] as number) - cy, (pz[i] as number) - cz)
    }
    return { key, x: cx, y: cy, z: cz, spread: Math.max(SPREAD * 0.2, d / n), count: n }
  })

  const floor = -radius * 0.95

  /**
   * The entries joined to nothing, on a disc of their own.
   *
   * A phyllotaxis spiral — the arrangement seeds take in a sunflower head —
   * because it fills a disc evenly at any count, with no rows to line up and
   * no gaps that read as structure. They have no links, so any structure the
   * eye finds in them would be a lie.
   */
  const golden = Math.PI * (3 - Math.sqrt(5))
  const discR = radius * 1.15
  isolated.forEach((n, i) => {
    const t = (i + 0.5) / Math.max(1, isolated.length)
    const r = discR * Math.sqrt(t)
    const a = i * golden
    at.set(n.slug, {
      x: Math.cos(a) * r,
      y: floor - radius * 0.12,
      z: Math.sin(a) * r,
    })
  })

  /**
   * A reference to something nobody wrote, hung off whatever cited it.
   *
   * Pushed outward from the cloud's centre rather than dropped at a random
   * offset, so a stub never lands inside the cluster it belongs to and reads
   * as one of its members.
   */
  for (const gap of graph.missing) {
    const anchor = gap.from[0] ? at.get(gap.from[0]) : undefined
    if (!anchor) {
      at.set(gap.slug, {
        x: (unit(gap.slug, 5) - 0.5) * radius,
        y: (unit(gap.slug, 6) - 0.5) * radius,
        z: (unit(gap.slug, 7) - 0.5) * radius,
      })
      continue
    }
    const out = Math.hypot(anchor.x, anchor.y, anchor.z) || 1
    const reach = radius * 0.16
    at.set(gap.slug, {
      x: anchor.x + (anchor.x / out) * reach + (unit(gap.slug, 8) - 0.5) * reach,
      y: anchor.y + (anchor.y / out) * reach + (unit(gap.slug, 9) - 0.5) * reach,
      z: anchor.z + (anchor.z / out) * reach + (unit(gap.slug, 10) - 0.5) * reach,
    })
  }

  return { at, radius, floor, worlds }
}
