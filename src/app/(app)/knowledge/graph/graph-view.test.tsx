import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphView } from './graph-view'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * A graph that fails to draw fails silently: the SVG is still there, the page
 * still renders, and the nodes simply are not. One NaN coordinate does it, and
 * so does an edge whose endpoint is missing from the node list. Both are
 * exactly the kind of absence this view was built to expose, so neither is
 * left to be noticed by eye.
 */

const graph = (over: Partial<KnowledgeGraph> = {}): KnowledgeGraph => ({
  nodes: [
    { slug: 'alpha', title: 'Alpha', project: 'ACME', degree: 2, island: 0, x: 10, y: 10 },
    { slug: 'beta', title: 'Beta', project: null, degree: 1, island: 0, x: 60, y: 30 },
    { slug: 'lonely', title: 'Lonely', project: null, degree: 0, island: -1, x: 0, y: 200 },
  ],
  edges: [{ source: 'alpha', target: 'beta' }],
  missing: [{ slug: 'never-written', from: ['alpha'], x: 40, y: 80 }],
  islands: [2],
  width: 200,
  height: 220,
  isolatedFrom: 2,
  stats: {
    entries: 3,
    withReferences: 2,
    references: 3,
    resolved: 2,
    dangling: 1,
    isolated: 1,
    islands: 1,
  },
  ...over,
})

describe('the map draws', () => {
  it('draws every entry, and every reference to nothing', () => {
    // Counted by position rather than by element, because each node is drawn
    // twice — once as its glow and once as itself.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    for (const { x, y } of [...graph().nodes, ...graph().missing]) {
      expect(html).toContain(`cx="${x}"`)
      expect(html).toContain(`cy="${y}"`)
    }
  })

  it('draws a node joined to nothing, rather than leaving it out', () => {
    // The isolates are the finding. Dropping them for being edgeless would
    // remove the single most informative thing on the page.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('cy="200"')
  })

  it('draws a reference to an entry nobody wrote', () => {
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('stroke-dasharray')
    expect(html).toContain('var(--danger)')
  })

  it('never emits a NaN coordinate', () => {
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).not.toContain('NaN')
  })

  it('skips an edge whose endpoint is not on the map instead of throwing', () => {
    // A superseded entry is excluded from the nodes; a reference to it must
    // not take the whole page down with it.
    const html = renderToStaticMarkup(
      <GraphView graph={graph({ edges: [{ source: 'alpha', target: 'gone' }] })} />,
    )

    expect(html).toContain('<circle')
    expect(html).not.toContain('NaN')
  })

  it('takes its colours from the theme tokens, so light and dark both work', () => {
    // A hard-coded hex here would look correct in whichever theme it was
    // written in and wrong in the other, with nothing to catch it.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    // The project palette is deliberately literal — `projectColor` is the same
    // hash every project icon in the app uses, and a project's colour is meant
    // to be its own in both themes. Everything structural is a token.
    expect(html).toContain('var(--bg)')
    expect(html).toContain('var(--fg-subtle)')
    expect(html).toContain('var(--danger)')
  })

  it('says what it is, for a reader who cannot see it', () => {
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toMatch(/aria-label="[^"]*joined to nothing"/)
  })

  it('bows its links rather than ruling them', () => {
    // Straight lines between hundreds of nodes cross into a hatch and every
    // one reads the same. The bow is what separates the crossings.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toMatch(/<path d="M[^"]*Q[^"]*"/)
  })

  it('gives every node the same drift on every render', () => {
    // The animation is seeded from the slug, never from a clock or a random,
    // for the same reason the layout is: this remounts whenever the live
    // stream reports a change, and a map that re-choreographs itself every few
    // minutes is a map nobody can read.
    const first = renderToStaticMarkup(<GraphView graph={graph()} />)
    const second = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(second).toBe(first)
    expect(first).toContain('--drift')
  })

  it('runs light along a link only where something is being looked at', () => {
    // A pulse on all 450 links is a repaint every frame, and a map that
    // shimmers everywhere says nothing about anywhere. Nothing is hovered in a
    // server render, so there should be no beam at all.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).not.toContain('graph-beam')
  })

  it('renders an empty corpus without drawing anything', () => {
    const html = renderToStaticMarkup(
      <GraphView graph={graph({ nodes: [], edges: [], missing: [], isolatedFrom: 0 })} />,
    )

    // The legend has circles of its own, so this asks about the map rather
    // than about the document: nothing clickable, nothing to hover.
    expect(html).not.toContain('cursor-pointer')
    expect(html).not.toContain('cursor-help')
    expect(html).not.toContain('NaN')
  })

  it('says what every mark on it means, on the map itself', () => {
    // "What are the dotted red circles?" was asked after ten minutes of
    // looking at this, and the answer only existed in a caption below the
    // frame. A map whose key is somewhere else is a map with no key.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('never written')
    expect(html).toContain('more links')
    expect(html).toContain('joined to nothing')
  })

  it('does not stack one title on another', () => {
    // A dozen overlapping titles is worse than none: the smear hides the
    // nodes underneath as well as itself.
    const crowded = graph({
      nodes: Array.from({ length: 12 }, (_, i) => ({
        slug: `n${i}`,
        title: `A fairly long knowledge title number ${i}`,
        project: null,
        degree: 9,
        island: 0,
        x: 100 + i,
        y: 100,
      })),
    })
    const html = renderToStaticMarkup(<GraphView graph={crowded} />)

    // Twelve nodes a pixel apart, all important enough to label: at most one
    // title can fit there.
    expect((html.match(/A fairly long knowledge title/g) ?? []).length).toBe(1)
  })
})
