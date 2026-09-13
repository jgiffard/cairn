import { describe, expect, it } from 'vitest'
import { normaliseRemote, projectKeyFromRepoRows } from './repos'

describe('normaliseRemote', () => {
  it('resolves the ssh and https spellings of one repo to the same string', () => {
    // The whole point: a clone made either way must reach the same row.
    expect(normaliseRemote('git@github.com:montytorr/cairn.git')).toBe('github.com/montytorr/cairn')
    expect(normaliseRemote('https://github.com/montytorr/cairn.git')).toBe(
      'github.com/montytorr/cairn',
    )
  })

  it('drops credentials, so a tokenised remote is not a different repository', () => {
    expect(normaliseRemote('https://thierry:ghp_secret@github.com/montytorr/cairn.git')).toBe(
      'github.com/montytorr/cairn',
    )
  })

  it('drops a port, which is transport and not identity', () => {
    expect(normaliseRemote('ssh://git@github.com:22/montytorr/cairn.git')).toBe(
      'github.com/montytorr/cairn',
    )
  })

  it('ignores case and a trailing slash', () => {
    expect(normaliseRemote('https://GitHub.com/MontyTorr/Cairn/')).toBe(
      'github.com/montytorr/cairn',
    )
  })

  it('leaves a host it does not recognise alone rather than guessing', () => {
    expect(normaliseRemote('git@gitlab.com:webcoder31/adhaf.git')).toBe(
      'gitlab.com/webcoder31/adhaf',
    )
  })
})

describe('projectKeyFromRepoRows', () => {
  it('resolves when exactly one project claims the repository', () => {
    expect(projectKeyFromRepoRows([{ project: { key: 'CAI' } }])).toBe('CAI')
  })

  it('resolves to nothing when the repository is unknown', () => {
    expect(projectKeyFromRepoRows([])).toBeNull()
  })

  it('reads the embed whether PostgREST returns an object or a one-row array', () => {
    // The sibling lookup in context.ts has to do the same dance; the shape
    // depends on how the relationship is inferred, not on the data.
    expect(projectKeyFromRepoRows([{ project: [{ key: 'CAI' }] }])).toBe('CAI')
  })

  it('refuses to choose when several projects claim the repository', () => {
    // A monorepo split across projects matches twice. Picking the first would
    // be silently wrong for months; falling through lets the caller answer.
    expect(
      projectKeyFromRepoRows([{ project: { key: 'CAI' } }, { project: { key: 'WEB' } }]),
    ).toBeNull()
  })
})
