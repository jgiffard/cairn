'use client'

import dynamic from 'next/dynamic'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Map as MapIcon } from 'lucide-react'
import { GraphFlat } from './graph-flat'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The map, and the choice of how to draw it.
 *
 * Two renderers sit under this: the flat SVG one, which is the original and
 * still the honest answer to "how much of this corpus is joined to nothing",
 * and a WebGL scene you can orbit. The shell owns the things that belong to
 * neither — what is under the pointer, the legend, the toggle — so that the
 * title bar reads the same whichever is mounted and hovering a node means the
 * same thing in both.
 *
 * three.js is a large dependency and it is only ever needed here, so the scene
 * is loaded on demand. `ssr: false` is not a preference: it touches `document`
 * to build its textures and reads the stylesheet for the palette, neither of
 * which exist on the server.
 */
const GraphScene = dynamic(() => import('./graph-scene'), {
  ssr: false,
  loading: () => null,
})

type Props = { graph: KnowledgeGraph }

type Mode = 'scene' | 'flat'

const STORAGE = 'cairn:knowledge-map-mode'

/**
 * Whether this browser can actually do it.
 *
 * Asked by trying, because the alternatives all lie: a WebGL2 entry in
 * `navigator` says nothing about whether a context can be allocated, and
 * machines with the GPU blocklisted report support right up until creation
 * fails. A failed probe here is what keeps the flat map on screen instead of a
 * black rectangle.
 *
 * Asked exactly once, and the answer kept. The probe allocates a real context,
 * and it is read on every render through `useSyncExternalStore`, which
 * compares what it gets back by identity — an uncached boolean would be a new
 * probe per render and a new context per probe.
 */
let probed: { able: boolean; mode: Mode } | null = null

const capability = (): { able: boolean; mode: Mode } => {
  if (probed) return probed
  let able = false
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl) {
      able = true
      // Released immediately: a probe that keeps its context spends one of the
      // handful the browser will hand out.
      ;(gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    able = false
  }
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(STORAGE)
  } catch {
    // Private windows and blocked site data both throw here, and a remembered
    // preference is not worth failing a render over.
  }
  probed = { able, mode: able && saved !== 'flat' ? 'scene' : 'flat' }
  return probed
}

/**
 * Nothing to subscribe to: the answer cannot change while the page is open.
 *
 * `useSyncExternalStore` rather than a `useState` set from an effect, because
 * this is exactly what it is for — a value React cannot compute during render
 * on the server, read consistently on the client. Done with an effect instead,
 * the first paint is always the flat map and a capable browser then re-renders
 * into the scene, which is the cascading render the rule warns about and which
 * anyone on WebGL would see as a flash.
 */
const noSubscribe = () => () => {}
/** The server has no canvas, and the flat map is the safe thing to agree on. */
const onServer = (): { able: boolean; mode: Mode } => SERVER_STATE
const SERVER_STATE: { able: boolean; mode: Mode } = { able: false, mode: 'flat' }

export const GraphView = ({ graph }: Props) => {
  const [focused, setFocused] = useState<string | null>(null)

  const { able, mode: preferred } = useSyncExternalStore(noSubscribe, capability, onServer)
  /** What the toggle was last set to, which outranks the remembered answer. */
  const [chosen, setChosen] = useState<Mode | null>(null)
  const mode = able ? (chosen ?? preferred) : 'flat'

  const choose = useCallback((next: Mode) => {
    setChosen(next)
    setFocused(null)
    try {
      window.localStorage.setItem(STORAGE, next)
    } catch {
      // As above: remembering is a convenience, not a requirement.
    }
  }, [])

  const at = useMemo(() => new Map(graph.nodes.map((n) => [n.slug, n])), [graph.nodes])
  const hovered = focused ? at.get(focused) : null
  const hoveredMissing = focused ? graph.missing.find((m) => m.slug === focused) : null

  return (
    <div className="bg-bg relative h-full w-full overflow-hidden">
      {mode === 'scene' && able ? (
        <GraphScene graph={graph} focused={focused} onHover={setFocused} />
      ) : (
        <GraphFlat graph={graph} focused={focused} setFocused={setFocused} />
      )}

      {/* What is under the pointer. One bar, written once, over either
          renderer — hovering a node has to mean the same thing in both or the
          toggle stops being a change of view and becomes a change of page. */}
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
              {/* The world it belongs to, which is what the coloured regions
                  in the scene are. Only when it adds something: repeating the
                  project key back as its own entity would be noise. */}
              {hovered.entity && hovered.entity !== hovered.project
                ? ` · ${hovered.entity}`
                : ''}
            </span>
          </span>
        ) : hoveredMissing ? (
          <span className="text-danger">
            {hoveredMissing.slug} — never written, referenced by {hoveredMissing.from.length}
          </span>
        ) : (
          // Written for whatever is actually being used. On a phone the flat
          // map's bar read "Hover a node · scroll to zoom", naming two
          // gestures that do not exist there and omitting the one that does.
          <>
            <span className="hidden sm:inline">
              {mode === 'scene' && able
                ? 'Hover a node · drag to orbit · scroll to move in or out'
                : 'Hover a node · drag to pan · scroll to zoom · double-click to reset'}
            </span>
            <span className="sm:hidden">
              {mode === 'scene' && able
                ? 'Tap a node · drag to orbit · pinch to move in'
                : 'Tap a node · drag to pan · pinch to zoom'}
            </span>
          </>
        )}
      </div>

      {/* Flat or spatial. Offered rather than decided, because the two are
          good at different things: the scene shows how the corpus clusters,
          the flat map shows what is joined to nothing without anything being
          able to hide behind anything else. Hidden entirely where WebGL is
          unavailable — a toggle to something that cannot be drawn is worse
          than no toggle. */}
      {able ? (
        <div
          role="group"
          aria-label="How to draw the map"
          className="border-border bg-surface/90 absolute top-2 right-2 flex items-center gap-0.5 rounded-md border p-0.5 backdrop-blur"
        >
          <button
            type="button"
            aria-pressed={mode === 'scene'}
            onClick={() => choose('scene')}
            title="Spatial — drag to orbit"
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[0.7rem] transition-colors ${
              mode === 'scene'
                ? 'bg-surface-raised text-fg'
                : 'text-fg-subtle hover:text-fg'
            }`}
          >
            <Box size={12} aria-hidden />
            Spatial
          </button>
          <button
            type="button"
            aria-pressed={mode === 'flat'}
            onClick={() => choose('flat')}
            title="Flat — every entry visible at once"
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[0.7rem] transition-colors ${
              mode === 'flat' ? 'bg-surface-raised text-fg' : 'text-fg-subtle hover:text-fg'
            }`}
          >
            <MapIcon size={12} aria-hidden />
            Flat
          </button>
        </div>
      ) : null}

      {/* The legend, because "what are the dotted red circles?" was the first
          thing asked after ten minutes of looking at this. Every mark on the
          map means something and none of it was stated where it was being
          read. */}
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
          <dd>
            {mode === 'scene' && able
              ? 'the disc below — joined to nothing'
              : 'the band at the foot — joined to nothing'}
          </dd>
        </div>
        {/* Only in the scene, because only the scene draws them. A legend
            entry for something that is not on screen is worse than none. */}
        {mode === 'scene' && able ? (
          <div className="flex items-center gap-2">
            <svg width="26" height="10" aria-hidden className="shrink-0">
              <defs>
                <radialGradient id="legend-world">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                </radialGradient>
              </defs>
              <circle cx="13" cy="5" r="9" fill="url(#legend-world)" />
            </svg>
            <dd>a named glow — one entity, the world a project belongs to</dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}
