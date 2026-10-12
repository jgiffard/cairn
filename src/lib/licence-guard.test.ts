import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Cairn is MIT. For a few weeks in 2026 it was not, and that licence left its
 * wording in the README, CONTRIBUTING, a history file and package.json. This
 * pins the licence and keeps the old wording from coming back in a doc, a
 * footer or a copied paragraph.
 *
 * CHANGELOG.md is skipped: its old release entries are history and say what
 * was true when they were written. The patterns are spelled as regexes rather
 * than as the phrases themselves, so a `git grep` for those phrases does not
 * find this file.
 */

const ROOT = join(__dirname, '..', '..')

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)

const SKIP = /(^|\/)(CHANGELOG\.md|package-lock\.json|licence-guard\.test\.ts)$|\.(png|jpe?g|gif|ico|woff2?|pdf)$/

const OLD_LICENCE = [
  /sustainable\s+use/i,
  /fair[- ]code/i,
  /source[- ]available/i,
  /internal\s+business\s+purposes/i,
  /LICENSE[-_]MIT/i,
  /\bSUL\b/,
]

const MIT = 'MIT'

const readJson = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))

describe('Cairn is MIT licensed', () => {
  it('ships the MIT licence text', () => {
    const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
    expect(licence.startsWith('MIT License\n')).toBe(true)
    expect(licence).toMatch(/^Copyright \(c\) \d{4}(-\d{4})? Callum Torr$/m)
  })

  it('says MIT in every package manifest and lockfile root', () => {
    for (const dir of ['', 'mcp/']) {
      expect(readJson(`${dir}package.json`).license, `${dir}package.json`).toBe(MIT)
      expect(readJson(`${dir}package-lock.json`).packages[''].license, `${dir}package-lock.json`).toBe(MIT)
    }
  })

  it('carries no wording from the previous licence', () => {
    const found: string[] = []
    for (const file of tracked()) {
      if (SKIP.test(file)) continue
      const path = join(ROOT, file)
      try {
        if (statSync(path).size > 2_000_000) continue
      } catch {
        continue
      }
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (OLD_LICENCE.some((pattern) => pattern.test(line))) {
            found.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`)
          }
        })
    }

    expect(found, `Cairn is MIT; this reads like the previous licence:\n\n${found.join('\n')}`).toEqual([])
  })
})
