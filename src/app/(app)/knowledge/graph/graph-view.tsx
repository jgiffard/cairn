'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { projectColor } from '@/components/icons'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

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
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

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
    const w = Math.max(1, Math.max(...xs) - minX)
    const h = Math.max(1, Math.max(...ys) - minY)
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

  const named = useMemo(
    () =>
      graph.nodes
        .filter((n) => n.degree >= LABEL_AT)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 28),
    [graph.nodes],
  )

  const reset = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  return (
    <div className="bg-bg relative h-full w-full overflow-hidden">
      <svg
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className="graph block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        role="img"
        aria-label={`${graph.stats.entries} knowledge entries, ${graph.edges.length} links between them, ${graph.stats.isolated} joined to nothing`}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const from = drag.current
          if (!from) return
          // Screen pixels are viewBox units scaled by the zoom, so a drag has
          // to be divided back out or the map races the cursor.
          const scale = box.w / (event.currentTarget.clientWidth || 1) / zoom
          setPan({
            x: from.panX + (event.clientX - from.x) * scale,
            y: from.panY + (event.clientY - from.y) * scale,
          })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onDoubleClick={reset}
        onWheel={(event) => {
          // Safe to take now: this page does not scroll. It used to, and the
          // caption under the frame meant scrolling down to read it zoomed the
          // map out instead — which is how it was found at 0.6 with the reset
          // button showing.
          event.preventDefault()
          setZoom((z) => Math.min(8, Math.max(0.6, z * (event.deltaY < 0 ? 1.12 : 0.89))))
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
                    opacity={on ? (focused ? 0.9 : 0.34) : 0.05}
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
                <g key={gap.slug} opacity={on ? 1 : 0.06}>
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
                <Link href={`/knowledge/${n.slug}`}>
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={r}
                    fill={colour}
                    stroke="var(--bg)"
                    strokeWidth={n.degree === 0 ? 0.7 : 1.1}
                    opacity={on ? (n.degree === 0 ? 0.6 : 1) : 0.07}
                    onPointerEnter={() => setFocused(n.slug)}
                    onPointerLeave={() => setFocused(null)}
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
            {(focused
              ? graph.nodes.filter((n) => lit(n.slug) && n.degree > 0).slice(0, 40)
              : named
            ).map((n) => (
              <text
                key={n.slug}
                x={n.x}
                y={n.y - radiusOf(n.degree) - 4}
                textAnchor="middle"
                fill="var(--fg-muted)"
                fontSize={7.5}
                stroke="var(--bg)"
                strokeWidth={2.4}
                paintOrder="stroke"
                opacity={focused ? 1 : 0.75}
              >
                {n.title.length > 38 ? `${n.title.slice(0, 37)}…` : n.title}
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

      <div className="border-border bg-surface/90 text-fg-subtle pointer-events-none absolute top-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-md border px-2.5 py-1.5 text-[0.7rem] backdrop-blur">
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

      <p className="text-fg-subtle pointer-events-none absolute bottom-2 left-2 max-w-md text-[0.68rem] leading-relaxed">
        Each dot is an entry, sized by its links and coloured by its project. Islands are laid
        out separately, so a cluster on its own really is on its own. The band along the foot
        is everything joined to nothing at all; a dashed red ring is a reference to an entry
        nobody ever wrote.
      </p>

      {zoom !== 1 || pan.x !== 0 || pan.y !== 0 ? (
        <button
          type="button"
          onClick={reset}
          className="border-border bg-surface text-fg-subtle hover:text-fg absolute right-2 bottom-2 rounded-md border px-2 py-1 text-[0.7rem]"
        >
          Reset view
        </button>
      ) : null}
    </div>
  )
}
