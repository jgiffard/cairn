import { describe, expect, it } from 'vitest'

import { excerptAround } from './mentions'

describe('excerptAround', () => {
  it('returns short text whole, flattened to one line', () => {
    expect(excerptAround('same cause as\nBB-333,  fixed there', 'BB-333')).toBe(
      'same cause as BB-333, fixed there',
    )
  })

  it('centres a long text on the ref and cuts on word boundaries', () => {
    const before = 'word '.repeat(80)
    const after = ' tail'.repeat(80)
    const out = excerptAround(`${before}do NOT generalise to BB-333 here${after}`, 'BB-333')

    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toContain('do NOT generalise to BB-333 here')
    // Whole words at both cuts, never half of one.
    expect(out).toMatch(/^…word /)
    expect(out).toMatch(/ tail…$/)
    expect(out.length).toBeLessThan(360)
  })

  it('does not take a longer ref for the one asked about', () => {
    const out = excerptAround(`${'x '.repeat(200)}BB-3330 is different; BB-333 is this one`, 'BB-333')
    expect(out).toContain('BB-333 is this one')
  })
})
