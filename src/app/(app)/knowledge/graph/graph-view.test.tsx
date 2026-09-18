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
  it('renders one circle per entry, plus one per reference to nothing', () => {
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html.match(/<circle/g)).toHaveLength(4)
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

    expect(html).toContain('var(--bg)')
    expect(html).toContain('var(--border-strong)')
  })

  it('says what it is, for a reader who cannot see it', () => {
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toMatch(/aria-label="[^"]*joined to nothing"/)
  })

  it('renders an empty corpus without drawing anything', () => {
    const html = renderToStaticMarkup(
      <GraphView graph={graph({ nodes: [], edges: [], missing: [], isolatedFrom: 0 })} />,
    )

    expect(html).not.toContain('<circle')
    expect(html).not.toContain('NaN')
  })
})
