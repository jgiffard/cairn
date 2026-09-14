import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A CSS trap that cost time twice in one day.
 *
 * Setting ONE overflow axis to `auto` forces the other from `visible` to
 * `auto`. `overflow-x-auto` therefore makes an element a scroll container in
 * *both* directions, and it then clips any absolutely positioned descendant
 * lying outside its box.
 *
 * That is why the bulk bar's Status and Priority menus did nothing: each
 * rendered at 168x195 some 191px above a bar whose own box was 40px tall, and
 * was clipped out of existence. It is also why an earlier mobile check passed
 * while the list was plainly scrolling sideways — the page did not scroll, an
 * inner container did.
 *
 * Clipping cannot be observed without layout, and jsdom has none, so this
 * guards the one thing that is checkable: the floating bar that opens those
 * menus must not carry a scroll utility. Deliberately narrow — a broader sweep
 * flagged the legitimate scroll areas *inside* menus and taught nothing.
 */
describe('the bulk bar is not a scroll container', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/projects/[key]/bulk-bar.tsx'),
    'utf8',
  )

  // The bar itself. It used to be identified by a hand-written drop shadow,
  // which stopped existing the moment the seventeen scattered shadows in the
  // product were centralised into one class — the guard then passed by finding
  // nothing, which is the worst way for a guard to fail. `pointer-events-auto`
  // is structural: the bar sits inside a `pointer-events-none` overlay
  // precisely so the page beneath stays usable, and it cannot lose that
  // without ceasing to be the bar.
  const barClasses = source
    .split('\n')
    .filter((line) => line.includes('pointer-events-auto') && line.includes('className'))

  // Without this the suite would go green after the bar was renamed, deleted
  // or restyled, having quietly stopped checking anything at all.
  it('has a bar to check', () => {
    expect(barClasses).toHaveLength(1)
  })

  it('carries no scroll utility, which would clip the menus it opens', () => {
    expect(barClasses[0]).not.toMatch(/overflow-[xy]?-?(auto|scroll)/)
  })

  it('still opens its menus above itself, which is what made clipping fatal', () => {
    // Unit-agnostic on purpose: what matters is that the popover is placed
    // outside the bar, not whether the offset is written in px or rem. This
    // assertion has now broken twice on details it never meant to pin — first
    // a drop shadow, then the switch to rem — and a guard that cries wolf is
    // one somebody eventually deletes.
    expect(source).toMatch(/absolute bottom-\[[\d.]+(px|rem)\]/)
  })
})
