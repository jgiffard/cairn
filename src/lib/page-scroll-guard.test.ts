import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The app layout renders `<main className="… overflow-hidden">`, so the shell
 * never scrolls and every page has to own its own scrolling. A page that
 * forgets does not overflow visibly — it simply clips, with no scrollbar and no
 * error, and the bottom of it is gone.
 *
 * Settings shipped that way and nobody noticed until the Entities section made
 * it taller than a viewport; /api-docs had the same hole, with `min-h-dvh`
 * guaranteeing the content was at least as tall as the area clipping it.
 *
 * Layout cannot be measured without a browser, so this checks the one thing
 * that is checkable from source: every page declares a scroll container.
 *
 * A page that genuinely fills the viewport — a canvas rather than a document —
 * says so with FILLS_VIEWPORT instead. That is an opt-out rather than a
 * loophole: it has to be written on purpose, it names itself in the diff, and
 * forgetting to scroll still fails exactly as before.
 */
const FILLS_VIEWPORT = 'page-scroll-guard: fills the viewport on purpose'
describe('every page scrolls itself', () => {
  const root = join(process.cwd(), 'src/app/(app)')

  const pages = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return pages(join(dir, entry.name))
      return entry.name === 'page.tsx' ? [join(dir, entry.name)] : []
    })

  it.each(pages(root).map((p) => [p.slice(root.length + 1), p]))(
    '%s',
    (_label, path) => {
      const source = readFileSync(path, 'utf8')
      if (source.includes(FILLS_VIEWPORT)) {
        // Then it must actually contain itself, or it clips in the other
        // direction and this opt-out has bought nothing.
        expect(source).toMatch(/h-dvh/)
        return
      }
      expect(
        source,
        `No scroll container. Add overflow-y-auto, or "${FILLS_VIEWPORT}" if this page ` +
          'is a canvas that fills the viewport.',
      ).toMatch(/overflow-(y-)?auto/)
    },
  )
})
