import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The CLI refuses flags it does not know, so the list of known flags has to be
 * right — and the first version was not.
 *
 * It was built by grepping `flags.X`, which missed every flag read dynamically:
 * `flags[k]` looping over ['type','status','priority'], and the [flag, field]
 * pairs in `run` and `session end`. It shipped, and `cairn add --priority high`
 * — documented in the CLI's own help — started exiting 2.
 *
 * A whitelist is only as trustworthy as its enumeration, so this compares it
 * against the help text, which is the contract people actually read.
 */
const source = readFileSync(join(process.cwd(), 'cli/cairn.mjs'), 'utf8')

const knownFlags = (): Set<string> => {
  const block = /const KNOWN_FLAGS = new Set\(\[([\s\S]*?)\]\)/.exec(source)
  if (!block) throw new Error('KNOWN_FLAGS not found in cli/cairn.mjs')
  return new Set([...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!))
}

/** Flags named in the help text, which is what the CLI promises. */
const helpFlags = (): Set<string> => {
  const help = /const HELP = `([\s\S]*?)`/.exec(source) ?? /ALWAYS START HERE([\s\S]*?)`/.exec(source)
  const text = help ? help[1]! : source
  return new Set([...text.matchAll(/--([a-z][a-z0-9-]+)/g)].map((m) => m[1]!))
}

describe('KNOWN_FLAGS', () => {
  it('contains every flag the help text offers', () => {
    const known = knownFlags()
    const missing = [...helpFlags()].filter((flag) => !known.has(flag))
    expect(missing, `help offers flags the parser would reject: ${missing.join(', ')}`).toEqual([])
  })

  it('contains every flag read dynamically, which a grep for `flags.` misses', () => {
    const known = knownFlags()
    // ['type','status','priority'] style loops, and [flag, field] pairs.
    const dynamic = [
      ...source.matchAll(/for \(const \w+ of \[([^\]]+)\]\) if \(flags/g),
      ...source.matchAll(/for \(const \[flag, field\] of \[([\s\S]*?)\]\) \{/g),
    ]
      .flatMap((m) => [...m[1]!.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((x) => x[1]!))
      .filter((name) => !['exitCode', 'durationMs'].includes(name))

    expect(dynamic.length).toBeGreaterThan(5)
    const missing = dynamic.filter((flag) => !known.has(flag) && !/^[a-z]+[A-Z]/.test(flag))
    expect(missing, `dynamically read but not known: ${missing.join(', ')}`).toEqual([])
  })

  it('still knows the flag whose absence caused the regression', () => {
    expect(knownFlags().has('priority')).toBe(true)
  })
})
