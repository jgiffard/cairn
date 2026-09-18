'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { projectColor } from '@/components/icons'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The map, drawn as inline SVG.
 *
 * SVG rather than canvas, and that is the load-bearing choice. Colour here is
 * `var(--border)`, `var(--accent)` and the project palette, so the light/dark
 * swap — a class flipped on `<html>` by next-themes, which notifies no
 * JavaScript at all — is a plain CSS repaint. A canvas would have to read the
 * custom properties back out with getComputedStyle and repaint the scene from
 * a MutationObserver on that class, which is a lot of machinery to end up
 * where a stylesheet already was.
 *
 * Every position arrives as a prop. Nothing is simulated here, so the picture
 * cannot move when `router.refresh()` lands after an agent writes a note.
 */

const PAD = 60

type Props = { graph: KnowledgeGraph }

export const GraphView = ({ graph }: Props) => {
  const [focused, setFocused] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  /** Who each node touches, so hovering one can dim everything it does not. */
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const { source, target } of graph.edges) {
      if (!map.has(source)) map.set(source, new Set())
      if (!map.has(target)) map.set(target, new Set())
      map.get(source)?.add(target)
      map.get(target)?.add(source)
    }
    for (const node of graph.missing) {
      for (const from of node.from) {
        if (!map.has(from)) map.set(from, new Set())
        map.get(from)?.add(node.slug)
        if (!map.has(node.slug)) map.set(node.slug, new Set())
        map.get(node.slug)?.add(from)
      }
    }
    return map
  }, [graph.edges, graph.missing])

  const lit = (slug: string): boolean =>
    focused === null || focused === slug || (neighbours.get(focused)?.has(slug) ?? false)

  const node = useMemo(
    () => new Map(graph.nodes.map((n) => [n.slug, n])),
    [graph.nodes],
  )
  const hovered = focused ? node.get(focused) : null
  const hoveredMissing = focused ? graph.missing.find((m) => m.slug === focused) : null

  const viewBox = `${-PAD} ${-PAD} ${graph.width + PAD * 2} ${graph.height + PAD * 2}`

  return (
    <div className="border-border bg-surface relative overflow-hidden rounded-lg border">
      <svg
        viewBox={viewBox}
        className="block h-[68vh] w-full cursor-grab touch-none active:cursor-grabbing"
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
          const scale = (graph.width + PAD * 2) / (event.currentTarget.clientWidth || 1) / zoom
          setPan({
            x: from.panX + (event.clientX - from.x) * scale,
            y: from.panY + (event.clientY - from.y) * scale,
          })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          setZoom((z) => Math.min(6, Math.max(0.5, z * (event.deltaY < 0 ? 1.1 : 0.9))))
        }}
      >
        <g
          transform={`translate(${graph.width / 2} ${graph.height / 2}) scale(${zoom}) translate(${-graph.width / 2 + pan.x} ${-graph.height / 2 + pan.y})`}
        >
          <g stroke="var(--border-strong)" strokeLinecap="round">
            {graph.edges.map(({ source, target }) => {
              const a = node.get(source)
              const b = node.get(target)
              if (!a || !b) return null
              const on = lit(source) && lit(target)
              return (
                <line
                  key={`${source}-${target}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  strokeWidth={on && focused ? 1.6 : 0.9}
                  opacity={on ? (focused ? 0.85 : 0.4) : 0.06}
                />
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
                <g key={gap.slug} opacity={on ? 1 : 0.07}>
                  {anchor && (
                    <line
                      x1={anchor.x}
                      y1={anchor.y}
                      x2={gap.x}
                      y2={gap.y}
                      stroke="var(--danger)"
                      strokeWidth={0.9}
                      strokeDasharray="2 3"
                      opacity={0.5}
                    />
                  )}
                  <circle
                    cx={gap.x}
                    cy={gap.y}
                    r={3.4}
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth={1.1}
                    strokeDasharray="2 2"
                    onPointerEnter={() => setFocused(gap.slug)}
                    onPointerLeave={() => setFocused(null)}
                    className="cursor-help"
                  />
                </g>
              )
            })}
          </g>

          <g>
            {graph.nodes.map((n) => {
              const on = lit(n.slug)
              const radius = n.degree === 0 ? 3 : 3.6 + Math.min(7, Math.sqrt(n.degree) * 2.1)
              return (
                <Link key={n.slug} href={`/knowledge/${n.slug}`}>
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={radius}
                    fill={n.project ? projectColor(n.project) : 'var(--fg-subtle)'}
                    stroke="var(--bg)"
                    strokeWidth={n.degree === 0 ? 0.8 : 1.2}
                    opacity={on ? (n.degree === 0 ? 0.55 : 1) : 0.08}
                    onPointerEnter={() => setFocused(n.slug)}
                    onPointerLeave={() => setFocused(null)}
                    className="cursor-pointer"
                  />
                </Link>
              )
            })}
          </g>

          {/* Names only for the hubs, and only once something is hovered.
              Every label at once is a wall of text with a graph behind it. */}
          {focused && (
            <g className="pointer-events-none">
              {graph.nodes
                .filter((n) => lit(n.slug) && n.degree > 0)
                .slice(0, 40)
                .map((n) => (
                  <text
                    key={n.slug}
                    x={n.x + 9}
                    y={n.y + 3.5}
                    fill="var(--fg)"
                    fontSize={9}
                    stroke="var(--bg)"
                    strokeWidth={2.6}
                    paintOrder="stroke"
                  >
                    {n.title.length > 44 ? `${n.title.slice(0, 43)}…` : n.title}
                  </text>
                ))}
            </g>
          )}
        </g>
      </svg>

      <div className="border-border bg-surface/95 text-fg-subtle absolute top-2 left-2 rounded-md border px-2.5 py-1.5 text-[0.7rem] backdrop-blur">
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
          <span>Hover a node · drag to pan · ⌘-scroll to zoom</span>
        )}
      </div>

      {zoom !== 1 || pan.x !== 0 || pan.y !== 0 ? (
        <button
          type="button"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
          className="border-border bg-surface text-fg-subtle hover:text-fg absolute right-2 bottom-2 rounded-md border px-2 py-1 text-[0.7rem]"
        >
          Reset view
        </button>
      ) : null}
    </div>
  )
}
