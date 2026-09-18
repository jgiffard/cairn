'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { projectColor } from '@/components/icons'
import type { GraphNode, KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The map, drawn as inline SVG.
 *
 * SVG rather than canvas, and that is the load-bearing choice. Colour here is
 * `var(--border)`, `var(--danger)` and the project palette, so the light/dark
 * swap — a class flipped on `<html>` by next-themes, which notifies no
 * JavaScript at all — is a plain CSS repaint. A canvas would have to read the
 * custom properties back out with getComputedStyle and repaint the scene from
 * a MutationObserver on that class, which is a lot of machinery to end up
 * where a stylesheet already was.
 *
 * It is also why this is not WebGL. Three dimensions would photograph well and
 * read worse: depth hides exactly what this page exists to show — how much of
 * the corpus is joined to nothing — behind whatever happens to be in front of
 * it. What makes a flat map feel alive is light and motion, and both are
 * cheaper here than a camera.
 *
 * Every position arrives as a prop and nothing is simulated in the browser, so
 * the picture cannot jump when `router.refresh()` lands after an agent writes
 * a note. The drift below moves nodes AROUND those fixed anchors; it never
 * changes them.
 */

/** Breathing room around the drawing, as a share of its longest side. */
const MARGIN = 0.04

/** Enough links to be worth naming without being asked. */
const LABEL_AT = 6

type Props = { graph: KnowledgeGraph }

/** Deterministic, and the same hash the layout and the palette use. */
const hash = (key: string): number => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h
}

export const GraphView = ({ graph }: Props) => {
  const [focused, setFocused] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(
    null,
  )
  /** Live pointers, so two fingers can pinch. */
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ apart: number; zoom: number } | null>(null)
  /** Whether the gesture that just ended moved the map, read by the click. */
  const dragged = useRef(false)
  /** A click event does not carry it, and touch has to behave differently. */
  const lastPointer = useRef<string>('mouse')

  /** Who each node touches, so hovering one can dim everything it does not. */
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const join = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set())
      map.get(a)?.add(b)
    }
    for (const { source, target } of graph.edges) {
      join(source, target)
      join(target, source)
    }
    for (const gap of graph.missing) {
      for (const from of gap.from) {
        join(from, gap.slug)
        join(gap.slug, from)
      }
    }
    return map
  }, [graph.edges, graph.missing])

  const lit = (slug: string): boolean =>
    focused === null || focused === slug || (neighbours.get(focused)?.has(slug) ?? false)

  const node = useMemo(() => new Map(graph.nodes.map((n) => [n.slug, n])), [graph.nodes])
  const hovered = focused ? node.get(focused) : null
  const hoveredMissing = focused ? graph.missing.find((m) => m.slug === focused) : null

  /**
   * The frame, fitted to what is actually drawn.
   *
   * Sized from the extremes of every node and stub rather than from the
   * layout's own numbers, because a dangling stub sits outside the island it
   * hangs off and would otherwise be clipped at the edge.
   */
  const box = useMemo(() => {
    const xs = [...graph.nodes.map((n) => n.x), ...graph.missing.map((m) => m.x)]
    const ys = [...graph.nodes.map((n) => n.y), ...graph.missing.map((m) => m.y)]
    if (xs.length === 0) return { x: 0, y: 0, w: 100, h: 100 }
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    // Floored at something drawable. A single entry puts every coordinate at
    // zero, and a 1-unit box against a node of radius 2.6 with a halo of 8.3
    // scaled that one dot to fill the window.
    const w = Math.max(90, Math.max(...xs) - minX)
    const h = Math.max(90, Math.max(...ys) - minY)
    const pad = Math.max(w, h) * MARGIN
    return { x: minX - pad, y: minY - pad, w: w + pad * 2, h: h + pad * 2 }
  }, [graph.nodes, graph.missing])

  /** A radius that makes a hub look like one. */
  const radiusOf = (degree: number): number =>
    degree === 0 ? 2.6 : 3.4 + Math.min(9, Math.sqrt(degree) * 2.6)

  /**
   * A link, bowed rather than ruled.
   *
   * Straight lines between hundreds of nodes cross into a hatch pattern and
   * every one of them reads the same. A consistent bow — always the same side,
   * always the same fraction of the span — separates the crossings and gives
   * the web the look of something grown rather than drawn.
   */
  const curve = (ax: number, ay: number, bx: number, by: number): string => {
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy) || 1
    const bow = Math.min(18, length * 0.12)
    return `M${ax} ${ay} Q${mx - (dy / length) * bow} ${my + (dx / length) * bow} ${bx} ${by}`
  }

  /**
   * Which titles to draw, chosen so that none lands on another.
   *
   * Drawn by importance and skipped on collision. Without this the dense
   * clusters stacked a dozen titles into one grey smear — worse than no labels
   * at all, because it hid the nodes underneath as well as itself.
   *
   * The text is sized in SCREEN units, not map units, so zooming in does not
   * magnify the same wall of text: the boxes shrink against the map, more of
   * them fit, and the corpus labels itself as you go in. Which is the
   * behaviour anyone who has used a map expects.
   */
  const labels = useMemo(() => {
    const size = 7.6 / zoom
    const near = focused ? neighbours.get(focused) : null
    const candidates = focused
      ? graph.nodes
          .filter((n) => n.slug === focused || (near?.has(n.slug) ?? false))
          .sort((a, b) => (a.slug === focused ? -1 : b.slug === focused ? 1 : b.degree - a.degree))
      : graph.nodes.filter((n) => n.degree >= LABEL_AT).sort((a, b) => b.degree - a.degree)

    const placed: { x: number; y: number; w: number; h: number }[] = []
    const out: { node: GraphNode; text: string; size: number }[] = []

    for (const n of candidates.slice(0, 160)) {
      const text = n.title.length > 42 ? `${n.title.slice(0, 41)}…` : n.title
      // Close enough for a box test, and far cheaper than measuring text.
      const w = text.length * size * 0.5
      const h = size * 1.35
      const x = n.x - w / 2
      const y = n.y - radiusOf(n.degree) - 4 - h

      const clash = placed.some(
        (b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y,
      )
      if (clash) continue

      placed.push({ x, y, w, h })
      out.push({ node: n, text, size })
      if (out.length >= 60) break
    }
    return out
  }, [graph.nodes, focused, zoom, neighbours])

  const reset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const svg = useRef<SVGSVGElement>(null)

  /**
   * Zoom, anchored where the pointer is.
   *
   * Anchored to the centre of the box it pushed whatever you were looking at
   * off the screen, so reading one island meant alternating zoom and drag.
   * Keeping the point under the cursor fixed is what every map does.
   */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const element = svg.current
      setZoom((current) => {
        const next = Math.min(8, Math.max(0.6, current * factor))
        if (!element || clientX === undefined || clientY === undefined) return next

        const rect = element.getBoundingClientRect()
        // Where the cursor is in the frame, as a share of it, measured from
        // the centre — the point the transform rotates around.
        const fx = (clientX - rect.left) / (rect.width || 1) - 0.5
        const fy = (clientY - rect.top) / (rect.height || 1) - 0.5
        const shownW = box.w / current
        const shownH = box.h / current
        const grownW = box.w / next
        const grownH = box.h / next
        setPan((p) => ({
          x: p.x + fx * (grownW - shownW),
          y: p.y + fy * (grownH - shownH),
        }))
        return next
      })
    },
    [box.w, box.h],
  )

  /**
   * The wheel, attached by hand.
   *
   * React registers `wheel` passively, so `preventDefault` inside an `onWheel`
   * prop does nothing at all — the browser logs that it was ignored. Nothing
   * scrolled only because this page happens not to, and ctrl+wheel still
   * zoomed the browser and the map at once.
   */
  useEffect(() => {
    const element = svg.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  return (
    <div className="bg-bg relative h-full w-full overflow-hidden">
      <svg
        ref={svg}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className="graph block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        role="img"
        aria-label={`${graph.stats.entries} knowledge entries, ${graph.edges.length} links between them, ${graph.stats.isolated} joined to nothing`}
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType
          touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            panX: pan.x,
            panY: pan.y,
            moved: false,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (touches.current.has(event.pointerId)) {
            touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          }

          /**
           * Two fingers: pinch.
           *
           * `touch-action: none` is what lets this pan at all, and it also
           * turns off the browser's own pinch — so without this the map had no
           * zoom whatsoever on a phone, which meant 377 nodes as sub-pixel
           * dots with no way to get closer.
           */
          if (touches.current.size >= 2) {
            const [a, b] = [...touches.current.values()]
            if (a && b) {
              const apart = Math.hypot(a.x - b.x, a.y - b.y)
              if (!pinch.current) pinch.current = { apart, zoom }
              else if (pinch.current.apart > 0) {
                const wanted = pinch.current.zoom * (apart / pinch.current.apart)
                zoomAt(wanted / zoom, (a.x + b.x) / 2, (a.y + b.y) / 2)
              }
            }
            drag.current = null
            return
          }

          const from = drag.current
          if (!from) return
          if (event.pointerType === 'mouse' && event.buttons === 0) {
            drag.current = null
            return
          }
          // Screen pixels are viewBox units scaled by the zoom, so a drag has
          // to be divided back out or the map races the cursor.
          const scale = box.w / (event.currentTarget.clientWidth || 1) / zoom
          if (Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) > 4) {
            from.moved = true
          }
          setPan({
            x: from.panX + (event.clientX - from.x) * scale,
            y: from.panY + (event.clientY - from.y) * scale,
          })
        }}
        onPointerUp={(event) => {
          touches.current.delete(event.pointerId)
          if (touches.current.size < 2) pinch.current = null
          dragged.current = drag.current?.moved ?? false
          drag.current = null
        }}
        onDoubleClick={reset}
        onPointerCancel={(event) => {
          // Without this a cancelled gesture — a long-press menu, a touch the
          // system took over — leaves the drag open, and since pointermove
          // fires on plain hover the map then pans with no button held.
          touches.current.delete(event.pointerId)
          pinch.current = null
          drag.current = null
        }}
      >
        <defs>
          {/* Light falls off around a node instead of stopping at its edge.
              Two circles rather than a blur filter: a filter over hundreds of
              nodes is a repaint the browser struggles with, and this costs
              nothing. */}
          <radialGradient id="halo">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.12" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g
          transform={`translate(${box.x + box.w / 2} ${box.y + box.h / 2}) scale(${zoom}) translate(${-(box.x + box.w / 2) + pan.x} ${-(box.y + box.h / 2) + pan.y})`}
        >
          <g stroke="var(--fg-subtle)" strokeLinecap="round" fill="none">
            {graph.edges.map(({ source, target }) => {
              const a = node.get(source)
              const b = node.get(target)
              if (!a || !b) return null
              const on = lit(source) && lit(target)
              const path = curve(a.x, a.y, b.x, b.y)
              return (
                <g key={`${source}-${target}`}>
                  <path
                    d={path}
                    strokeWidth={on && focused ? 1.5 : 1}
                    opacity={on ? (focused ? 0.9 : 0.34) : 0.09}
                  />
                  {/* Light travelling the links of whatever is being looked at.
                      Only those links: a pulse on all 450 is a repaint every
                      frame, and a map that shimmers everywhere says nothing
                      about anywhere. */}
                  {focused && on && (
                    <path
                      className="graph-beam"
                      d={path}
                      stroke={a.project ? projectColor(a.project) : 'var(--accent)'}
                      strokeWidth={1.8}
                    />
                  )}
                </g>
              )
            })}
          </g>

          {/* A reference to something nobody wrote, drawn where it was made.
              Dashed and hollow, because the whole point is that it is not
              there — dropping it is what kept 31 of these invisible. */}
          <g>
            {graph.missing.map((gap) => {
              const anchor = node.get(gap.from[0] as string)
              const on = lit(gap.slug)
              return (
                <g key={gap.slug} opacity={on ? 1 : 0.12}>
                  {anchor && (
                    <path
                      d={curve(anchor.x, anchor.y, gap.x, gap.y)}
                      fill="none"
                      stroke="var(--danger)"
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      opacity={0.55}
                    />
                  )}
                  <circle
                    cx={gap.x}
                    cy={gap.y}
                    r={3.6}
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth={1.2}
                    strokeDasharray="2.5 2"
                    onPointerEnter={() => setFocused(gap.slug)}
                    onPointerLeave={() => setFocused(null)}
                    className="cursor-help"
                  />
                </g>
              )
            })}
          </g>

          {/* Each node in its own group so the drift can move the group while
              the layout keeps the anchor. The phase comes from the slug, so
              the corpus breathes unevenly — every node on the same beat reads
              as a pulsing sheet rather than as something alive. */}
          {graph.nodes.map((n) => {
            const on = lit(n.slug)
            const r = radiusOf(n.degree)
            const colour = n.project ? projectColor(n.project) : 'var(--fg-muted)'
            const seed = hash(n.slug)
            return (
              <g
                key={n.slug}
                className="graph-node"
                style={
                  {
                    '--delay': `${-(seed % 9000) / 1000}s`,
                    '--drift': `${6 + (seed % 5)}s`,
                    '--rise': `${((seed % 700) / 1000).toFixed(2)}s`,
                  } as React.CSSProperties
                }
              >
                {on && (
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={r * 3.2}
                    fill="url(#halo)"
                    color={colour}
                    opacity={n.degree === 0 ? 0.35 : focused ? 1 : 0.8}
                    className="pointer-events-none"
                  />
                )}
                <Link
                  href={`/knowledge/${n.slug}`}
                  // Every node is in the viewport at once, so the default
                  // viewport prefetch schedules a request per entry on first
                  // paint — 377 of them, each through the app layout.
                  prefetch={false}
                  // The map is not a navigation surface; the page says so. One
                  // tab stop per entry would put several hundred unnamed,
                  // unstyled stops between the breadcrumb and the legend, and
                  // a focusable element inside role="img" is wrong anyway.
                  tabIndex={-1}
                >
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={r}
                    fill={colour}
                    stroke="var(--bg)"
                    strokeWidth={n.degree === 0 ? 0.7 : 1.1}
                    opacity={on ? (n.degree === 0 ? 0.6 : 1) : 0.16}
                    onPointerEnter={() => setFocused(n.slug)}
                    onPointerLeave={() => setFocused(null)}
                    onClick={(event) => {
                      // A drag that ended on a node is a drag, not a click.
                      // And on a touch screen the gesture that reveals a node
                      // IS the gesture that opens it, so the first tap reads
                      // it and only a second one follows the link.
                      if (dragged.current) event.preventDefault()
                      else if (lastPointer.current === 'touch' && focused !== n.slug) {
                        event.preventDefault()
                        setFocused(n.slug)
                      }
                    }}
                    className="cursor-pointer transition-opacity"
                  />
                </Link>
              </g>
            )
          })}

          {/* The hubs carry their names without being asked, because a map of
              unlabelled dots tells you the shape and nothing else. Everything
              quieter than that waits to be hovered, or the picture becomes a
              wall of text with a graph behind it. */}
          <g className="pointer-events-none">
            {labels.map(({ node: n, text, size }) => (
              <text
                key={n.slug}
                x={n.x}
                y={n.y - radiusOf(n.degree) - 4}
                textAnchor="middle"
                fill={n.slug === focused ? 'var(--fg)' : 'var(--fg-muted)'}
                fontSize={size}
                stroke="var(--bg)"
                strokeWidth={size * 0.34}
                paintOrder="stroke"
                opacity={focused ? 1 : 0.8}
              >
                {text}
              </text>
            ))}
          </g>

          {/* The map says what its own regions are. The band along the foot is
              the finding, and a reader should not have to infer it. */}
          {graph.stats.isolated > 0 && graph.nodes.length > graph.isolatedFrom && (
            <text
              x={box.x + box.w * 0.012}
              y={(graph.nodes[graph.isolatedFrom]?.y ?? 0) - 22}
              fill="var(--fg-subtle)"
              fontSize={9}
              stroke="var(--bg)"
              strokeWidth={2.6}
              paintOrder="stroke"
              className="pointer-events-none"
            >
              {graph.stats.isolated} joined to nothing
            </text>
          )}
        </g>
      </svg>

      <div className="border-border bg-surface/90 text-fg-subtle pointer-events-none absolute top-2 left-2 max-w-[min(42rem,calc(100%-1rem))] truncate rounded-md border px-2.5 py-1.5 text-[0.7rem] backdrop-blur">
        {hovered ? (
          <span className="text-fg">
            {hovered.title}
            <span className="text-fg-subtle">
              {' · '}
              {hovered.degree === 0
                ? 'joined to nothing'
                : `${hovered.degree} link${hovered.degree === 1 ? '' : 's'}`}
              {hovered.project ? ` · ${hovered.project}` : ' · global'}
            </span>
          </span>
        ) : hoveredMissing ? (
          <span className="text-danger">
            {hoveredMissing.slug} — never written, referenced by {hoveredMissing.from.length}
          </span>
        ) : (
          <span>Hover a node · drag to pan · scroll to zoom · double-click to reset</span>
        )}
      </div>

      {/* The legend, because "what are the dotted red circles?" was the first
          thing asked after ten minutes of looking at this. Every mark on the
          map means something and none of it was stated where it was being
          read — the explanation was eight lines of low-contrast prose below
          the frame, which is not where anyone looks. */}
      <dl className="border-border bg-surface/90 text-fg-subtle pointer-events-none absolute bottom-2 left-2 hidden space-y-1 rounded-md border px-2.5 py-2 text-[0.68rem] backdrop-blur sm:block">
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle cx="5" cy="5" r="2" fill="var(--fg-muted)" />
            <circle cx="18" cy="5" r="4.5" fill="var(--fg-muted)" />
          </svg>
          <dd>bigger — more links to other entries</dd>
        </div>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle cx="6" cy="5" r="3.5" fill="var(--accent)" />
            <circle cx="18" cy="5" r="3.5" fill="var(--fg-subtle)" />
          </svg>
          <dd>coloured by project · grey is global</dd>
        </div>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle
              cx="12"
              cy="5"
              r="4"
              fill="none"
              stroke="var(--danger)"
              strokeWidth="1.3"
              strokeDasharray="2.5 2"
            />
          </svg>
          <dd className="text-danger">referenced, but never written</dd>
        </div>
        <div className="flex items-center gap-2">
          <svg width="26" height="10" aria-hidden className="shrink-0">
            <circle cx="4" cy="5" r="1.6" fill="var(--fg-subtle)" opacity="0.6" />
            <circle cx="12" cy="5" r="1.6" fill="var(--fg-subtle)" opacity="0.6" />
            <circle cx="20" cy="5" r="1.6" fill="var(--fg-subtle)" opacity="0.6" />
          </svg>
          <dd>the band at the foot — joined to nothing</dd>
        </div>
      </dl>

      {/* A wheel is not the only way to zoom, and on a touch screen there is
          no wheel at all. Also the keyboard path into the map, since the nodes
          themselves are deliberately not tab stops. */}
      <div className="absolute right-2 bottom-2 flex items-center gap-1">
        {zoom !== 1 || pan.x !== 0 || pan.y !== 0 ? (
          <button
            type="button"
            onClick={reset}
            className="border-border bg-surface text-fg-subtle hover:text-fg rounded-md border px-2 py-1 text-[0.7rem]"
          >
            Reset view
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomAt(0.8)}
          className="border-border bg-surface text-fg-subtle hover:text-fg h-7 w-7 rounded-md border text-[0.9rem] leading-none"
        >
          −
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomAt(1.25)}
          className="border-border bg-surface text-fg-subtle hover:text-fg h-7 w-7 rounded-md border text-[0.9rem] leading-none"
        >
          +
        </button>
      </div>
    </div>
  )
}
