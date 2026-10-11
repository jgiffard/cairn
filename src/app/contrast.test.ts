import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { AVATAR_COLORS } from '@/components/icons'

/**
 * Every colour that carries text is at least 4.5:1 against every ground it is
 * set on, in both themes. Disabled is the only exception and is not a token.
 * The pairs are read from globals.css, so changing a token that breaks one
 * fails here rather than in a screenshot.
 */
const css = readFileSync('src/app/globals.css', 'utf8')

// Every block the selector opens: the tokens and the syntax colours are two.
const block = (selector: RegExp): Record<string, string> => {
  const found: Record<string, string> = {}
  const pattern = new RegExp(selector.source, 'gm')
  for (const match of css.matchAll(pattern)) {
    const open = css.indexOf('{', match.index)
    let depth = 0
    let end = open
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      if (css[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    const body = css.slice(open + 1, end)
    for (const m of body.matchAll(/^\s*--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/gm)) found[m[1]!] = m[2]!
  }
  return found
}

const light = block(/^:root\s*\{/m)
const dark = { ...light, ...block(/^:root\.dark\s*\{/m) }

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const GROUNDS = ['bg', 'bg-elevated', 'surface', 'surface-raised', 'surface-hover']
const TEXT = [
  'fg', 'fg-muted', 'fg-subtle', 'accent', 'danger',
  'status-backlog', 'status-todo', 'status-doing', 'status-in-review', 'status-done', 'status-cancelled',
  'type-feature', 'type-bug', 'type-improvement', 'type-chore', 'type-spike', 'type-docs',
  'priority-urgent', 'priority-high', 'priority-medium', 'priority-low',
]

describe.each([['light', light], ['dark', dark]] as const)('%s theme contrast', (_name, tokens) => {
  it('reads the tokens it checks', () => {
    for (const key of [...GROUNDS, ...TEXT]) expect(tokens[key], key).toMatch(/^#/)
  })

  it('keeps every text colour at 4.5:1 on every ground', () => {
    const failures = TEXT.flatMap((fg) =>
      GROUNDS.map((bg) => [fg, bg, ratio(tokens[fg]!, tokens[bg]!)] as const),
    )
      .filter(([, , r]) => r < 4.5)
      .map(([fg, bg, r]) => `${fg} on ${bg}: ${r.toFixed(2)}`)
    expect(failures).toEqual([])
  })

  it('keeps accent text readable on its tinted ground, and the button label on the accent', () => {
    expect(ratio(tokens['accent']!, tokens['accent-subtle']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(tokens['accent-fg']!, tokens['accent']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(tokens['danger']!, tokens['danger-subtle']!)).toBeGreaterThanOrEqual(4.5)
  })
})

const CODE = ['code-keyword', 'code-string', 'code-number', 'code-comment', 'code-function', 'code-type', 'code-variable']

describe('light theme surfaces (CAIRN-388)', () => {
  it('steps its grounds instead of laying white on white', () => {
    // The page is an off-white; panels, fields and floating surfaces are the
    // lightest thing on it; chrome and tinted fills sit a step below the page.
    expect(luminance(light['surface']!)).toBeGreaterThan(luminance(light['bg']!))
    expect(luminance(light['bg']!)).toBeGreaterThan(luminance(light['bg-elevated']!))
    expect(luminance(light['bg']!)).toBeGreaterThan(luminance(light['surface-raised']!))
    expect(ratio(light['surface']!, light['bg']!)).toBeGreaterThanOrEqual(1.1)
  })

  it('draws a hairline that shows on the page and on a panel', () => {
    for (const ground of ['bg', 'bg-elevated', 'surface']) {
      expect(ratio(light['border']!, light[ground]!), ground).toBeGreaterThanOrEqual(1.15)
    }
    expect(ratio(light['border-strong']!, light['bg']!)).toBeGreaterThan(ratio(light['border']!, light['bg']!))
  })

  it('keeps syntax colours readable on the surface a code block is drawn on', () => {
    const failures = CODE.map((token) => [token, ratio(light[token]!, light['surface']!)] as const)
      .filter(([, r]) => r < 4.5)
      .map(([token, r]) => `${token}: ${r.toFixed(2)}`)
    expect(failures).toEqual([])
  })
})

describe('avatars', () => {
  it('carries white initials at 4.5:1 on every colour', () => {
    const low = AVATAR_COLORS.filter((c) => ratio('#ffffff', c) < 4.5)
    expect(low).toEqual([])
  })
})
