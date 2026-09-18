import { describe, expect, it } from 'vitest'
import { SLUG_PATTERN, slugify } from './knowledge'

/**
 * The slug is the only name a fact has. `cairn know <subject>` decides between
 * fetching an entry and searching for one by testing the subject against
 * `SLUG_PATTERN`, and knowledge bodies cross-reference each other by slug —
 * so the shape of this string is the difference between following a reference
 * and getting a handful of loose search hits with no sign you missed.
 */
describe('knowledge slugs', () => {
  it('turns a claim into a hyphenated identifier', () => {
    expect(slugify('Zod .partial() keeps defaults')).toBe('zod-partial-keeps-defaults')
  })

  it('strips accents rather than dropping the words carrying them', () => {
    // The store is part French; "réessaye" must not become "r-essaye".
    expect(slugify('Le témoin réessaye')).toBe('le-temoin-reessaye')
  })

  it('never produces leading or trailing hyphens', () => {
    expect(slugify('  ...Akamai cookies!  ')).toBe('akamai-cookies')
  })

  it('separates with hyphens, never underscores', () => {
    // This is the whole reason 365 imported links resolve to nothing: the
    // bodies say `capsolver_akamai_bug`, every real slug says
    // `capsolver-akamai-bug`, and nothing reconciles the two.
    expect(slugify('capsolver akamai bug')).not.toContain('_')
    expect(slugify('capsolver_akamai_bug')).toBe('capsolver-akamai-bug')
  })

  it('returns empty for a title with nothing sluggable in it, rather than a bare hyphen', () => {
    // The caller relies on this: an empty result is what makes it ask for
    // --slug instead of writing an entry called "-".
    expect(slugify('!!! ???')).toBe('')
  })
})

describe('SLUG_PATTERN — what `cairn know` treats as a slug rather than a query', () => {
  it('accepts the shape slugify produces', () => {
    expect(SLUG_PATTERN.test('queueit-botdeflector-unsolvable')).toBe(true)
    expect(SLUG_PATTERN.test('clawdius-server')).toBe(true)
  })

  it('rejects the underscore spelling, which is why following a link fell through to search', () => {
    // Not a defect in the pattern — a fact about it worth pinning down, since
    // an agent typing the underscore form gets a search that can miss
    // silently rather than a fetch that succeeds.
    expect(SLUG_PATTERN.test('queueit_botdeflector_unsolvable')).toBe(false)
  })

  it('rejects anything with spaces, so a real query is never mistaken for a slug', () => {
    expect(SLUG_PATTERN.test('postgrest ambiguous embed')).toBe(false)
  })

  it('rejects uppercase, so a project key is never mistaken for a slug', () => {
    expect(SLUG_PATTERN.test('CAIRN-42')).toBe(false)
  })
})
