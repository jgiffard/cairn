import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { version } from '../../package.json'
import { parseChangelog } from './changelog'

const SAMPLE = `# Changelog

Notable changes, newest first.

## [Unreleased]

## [0.2.0] — 2026-10-01

### Fixed

- **A fix** (#1).

## [0.1.0] — 2026-09-12

First release.

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
`

describe('the changelog page', () => {
  it('splits releases on their headings and keeps the intro without the title', () => {
    const { intro, releases } = parseChangelog(SAMPLE)
    expect(intro).toBe('Notable changes, newest first.')
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ['0.2.0', '2026-10-01'],
      ['0.1.0', '2026-09-12'],
    ])
    expect(releases[0]?.body).toBe('### Fixed\n\n- **A fix** (#1).')
  })

  it('drops the reference definitions, which would print under the last release', () => {
    const { releases } = parseChangelog(SAMPLE)
    expect(releases[1]?.body).toBe('First release.')
  })

  it('keeps Unreleased when something is in it', () => {
    const { releases } = parseChangelog(SAMPLE.replace('## [Unreleased]\n', '## [Unreleased]\n\n- Coming.\n'))
    expect(releases[0]).toEqual({ version: 'Unreleased', date: null, body: '- Coming.' })
  })

  it('reads the real file, with the running release in it', () => {
    const { releases } = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'))
    expect(releases.some((r) => r.version === version)).toBe(true)
    expect(releases.every((r) => r.version === 'Unreleased' || /^\d+\.\d+\.\d+$/.test(r.version))).toBe(true)
  })
})
