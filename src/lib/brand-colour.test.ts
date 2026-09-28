import { describe, expect, it } from 'vitest'
import { HEX, contrast, paletteCss, paletteFor } from './brand-colour'

describe('an accent, per theme', () => {
  it('measures contrast the way WCAG does', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBe(1)
  })

  it('keeps a colour that already reads on white, and lifts it for the dark ground', () => {
    // Dispofi's navy: fine on white, nearly invisible on #08090a.
    const p = paletteFor('#01519b')
    expect(p.light.accent).toBe('#01519b')
    expect(contrast(p.dark.accent, '#08090a')).toBeGreaterThanOrEqual(5.5)
    expect(contrast('#01519b', '#08090a')).toBeLessThan(5.5)
  })

  it('darkens a colour that only reads on black, and keeps it for the dark ground', () => {
    const p = paletteFor('#f2c94c')
    expect(contrast(p.light.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(p.dark.accent).toBe('#f2c94c')
    // White on a yellow button is unreadable; the fill gets dark text.
    expect(p.dark.accentFg).toBe('#0d0e10')
  })

  it('moves as little as it has to', () => {
    // Each needs lifting for the dark ground; each should land just past the line.
    for (const hex of ['#1d6fd0', '#01519b', '#15803d', '#be123c']) {
      const ratio = contrast(paletteFor(hex).dark.accent, '#08090a')
      expect(ratio).toBeGreaterThanOrEqual(5.5)
      expect(ratio).toBeLessThan(6.2)
    }
  })

  it('writes white on a fill that carries it', () => {
    expect(paletteFor('#01519b').light.accentFg).toBe('#ffffff')
  })

  it('emits nothing but tokens and hex colours', () => {
    const css = paletteCss(paletteFor('#be123c'))
    const values = [...css.matchAll(/:([^;{}]+);/g)].map((m) => m[1]!)
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) expect(v).toMatch(HEX)
    expect(css).toMatch(/^html:root\{/)
    expect(css).toContain('html:root.dark{')
  })
})
