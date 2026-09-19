import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphFlat } from './graph-flat'
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
    { slug: 'alpha', title: 'Alpha', project: 'ACME', entity: null, degree: 2, island: 0, x: 10, y: 10 },
    { slug: 'beta', title: 'Beta', project: null, entity: null, degree: 1, island: 0, x: 60, y: 30 },
    { slug: 'lonely', title: 'Lonely', project: null, entity: null, degree: 0, island: -1, x: 0, y: 200 },
  ],
  entities: [],
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
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    for (const { x, y } of [...graph().nodes, ...graph().missing]) {
      expect(html).toContain(`cx="${x}"`)
      expect(html).toContain(`cy="${y}"`)
    }
  })

  it('draws a node joined to nothing, rather than leaving it out', () => {
    // The isolates are the finding. Dropping them for being edgeless would
    // remove the single most informative thing on the page.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).toContain('cy="200"')
  })

  it('draws a reference to an entry nobody wrote', () => {
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).toContain('stroke-dasharray')
    expect(html).toContain('var(--danger)')
  })

  it('never emits a NaN coordinate', () => {
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).not.toContain('NaN')
  })

  it('skips an edge whose endpoint is not on the map instead of throwing', () => {
    // A superseded entry is excluded from the nodes; a reference to it must
    // not take the whole page down with it.
    const html = renderToStaticMarkup(
      <GraphFlat graph={graph({ edges: [{ source: 'alpha', target: 'gone' }] })} focused={null} setFocused={() => {}} />,
    )

    expect(html).toContain('<circle')
    expect(html).not.toContain('NaN')
  })

  it('takes its colours from the theme tokens, so light and dark both work', () => {
    // A hard-coded hex here would look correct in whichever theme it was
    // written in and wrong in the other, with nothing to catch it.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    // The project palette is deliberately literal — `projectColor` is the same
    // hash every project icon in the app uses, and a project's colour is meant
    // to be its own in both themes. Everything structural is a token.
    expect(html).toContain('var(--bg)')
    expect(html).toContain('var(--fg-subtle)')
    expect(html).toContain('var(--danger)')
  })

  it('says what it is, for a reader who cannot see it', () => {
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).toMatch(/aria-label="[^"]*joined to nothing"/)
  })

  it('bows its links rather than ruling them', () => {
    // Straight lines between hundreds of nodes cross into a hatch and every
    // one reads the same. The bow is what separates the crossings.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).toMatch(/<path d="M[^"]*Q[^"]*"/)
  })

  it('gives every node the same drift on every render', () => {
    // The animation is seeded from the slug, never from a clock or a random,
    // for the same reason the layout is: this remounts whenever the live
    // stream reports a change, and a map that re-choreographs itself every few
    // minutes is a map nobody can read.
    const first = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)
    const second = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(second).toBe(first)
    expect(first).toContain('--drift')
  })

  it('runs light along a link only where something is being looked at', () => {
    // A pulse on all 450 links is a repaint every frame, and a map that
    // shimmers everywhere says nothing about anywhere. Nothing is hovered in a
    // server render, so there should be no beam at all.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).not.toContain('graph-beam')
  })

  it('renders an empty corpus without drawing anything', () => {
    const html = renderToStaticMarkup(
      <GraphFlat graph={graph({ nodes: [], edges: [], missing: [], isolatedFrom: 0 })} focused={null} setFocused={() => {}} />,
    )

    // The legend has circles of its own, so this asks about the map rather
    // than about the document: nothing clickable, nothing to hover.
    expect(html).not.toContain('cursor-pointer')
    expect(html).not.toContain('cursor-help')
    expect(html).not.toContain('NaN')
  })

  it('does not make every node a tab stop', () => {
    // role="img" makes the subtree presentational, but it does not remove
    // focusability: without this, Tab from the breadcrumb walked several
    // hundred unnamed, unstyled stops. The page says plainly that the map is
    // not a navigation surface; the zoom buttons are the keyboard path in.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-label="Zoom in"')
  })

  it('does not prefetch a route for every entry on the map', () => {
    // Every node is in the viewport at once, so the default viewport prefetch
    // schedules one request per entry on first paint — 377 of them here, each
    // through the app layout.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).not.toContain('prefetch="true"')
  })

  it('draws the glow for every node, lit or not', () => {
    // Mounting the halo only when lit meant focusing one node unmounted ~370
    // circles and remounted them on leave — a great deal of work to make a
    // picture quieter. It is always drawn and dimmed to nothing instead.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    // Two gradients, one glow. Entries with no project take the weaker one:
    // their colour is a plain grey, and a grey glow on a white ground reads
    // as a smudge rather than as light.
    const halos = (html.match(/url\(#halo\)/g) ?? []).length
    const global = (html.match(/url\(#halo-global\)/g) ?? []).length
    expect(halos + global).toBe(graph().nodes.length)
    expect(global).toBeGreaterThan(0)
  })

  it('gives the entries with no project a weaker glow than the rest', () => {
    // The one case where the halo had no hue to separate it from the ground.
    // Measured on the deployed map in light mode it read as a dirty cloud
    // behind the cluster, or as a compression artefact — not as light.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    const strong = html.match(/id="halo"[\s\S]*?<\/radialGradient>/)?.[0] ?? ''
    const weak = html.match(/id="halo-global"[\s\S]*?<\/radialGradient>/)?.[0] ?? ''
    const peak = (block: string) => Number(block.match(/stop-opacity="([\d.]+)"/)?.[1] ?? 0)
    expect(peak(weak)).toBeLessThan(peak(strong))
  })

  it('sizes titles against the rendered frame, not the map', () => {
    // The counter-scale held titles constant against the ZOOM but not against
    // the FIT, and the fit collapses when the window narrows. On a 500px
    // viewport every title came out at 3px — an illegible grey smear laid
    // over the dots rather than small text. There is no layout in a static
    // render, so what is asserted is the thing that broke: the size is not a
    // constant baked into the markup.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect(html).not.toContain('font-size="7.6"')
  })

  it('does not fade titles below the contrast the palette was measured at', () => {
    // --fg-muted is 5.86:1 on white and 5.14:1 on black, both of which clear
    // AA. The 0.8 opacity that used to be here dropped the light one to
    // 3.76:1 and put it under, at a 7.6px rendered size where the large-text
    // allowance does not apply.
    const crowded = graph({
      nodes: graph().nodes.map((n) => ({ ...n, degree: 9 })),
    })
    const html = renderToStaticMarkup(<GraphFlat graph={crowded} focused={null} setFocused={() => {}} />)

    const titles = html.match(/<text[^>]*paint-order="stroke"[^>]*>/g) ?? []
    expect(titles.length).toBeGreaterThan(0)
    for (const tag of titles) expect(tag).not.toMatch(/opacity="0\.8"/)
  })

  it('does not animate the entries joined to nothing', () => {
    // They sit in a grid at the foot of the map and read as a count, so there
    // is nothing for breathing to say about them — and it takes a third of the
    // animated groups off a loop that runs for as long as the page is open.
    const html = renderToStaticMarkup(<GraphFlat graph={graph()} focused={null} setFocused={() => {}} />)

    expect((html.match(/graph-still/g) ?? []).length).toBe(
      graph().nodes.filter((n) => n.degree === 0).length,
    )
  })

  it('does not stack one title on another', () => {
    // A dozen overlapping titles is worse than none: the smear hides the
    // nodes underneath as well as itself.
    const crowded = graph({
      nodes: Array.from({ length: 12 }, (_, i) => ({
        slug: `n${i}`,
        title: `A fairly long knowledge title number ${i}`,
        project: null,
        entity: null,
        degree: 9,
        island: 0,
        x: 100 + i,
        y: 100,
      })),
    })
    const html = renderToStaticMarkup(<GraphFlat graph={crowded} focused={null} setFocused={() => {}} />)

    // Twelve nodes a pixel apart, all important enough to label: at most one
    // title can fit there.
    expect((html.match(/A fairly long knowledge title/g) ?? []).length).toBe(1)
  })
})
