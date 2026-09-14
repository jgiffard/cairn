import { describe, expect, it } from 'vitest'
import { filesNamedIn } from './staleness'

describe('filesNamedIn', () => {
  it('finds the backticked paths a fact is about', () => {
    expect(filesNamedIn('See `src/lib/db/client.ts` and `migrations/015_file_touches.sql`.')).toEqual([
      'src/lib/db/client.ts',
      'migrations/015_file_touches.sql',
    ])
  })

  it('ignores a command that happens to be in backticks', () => {
    // `cairn check` is in almost every entry; reading it as a file would make
    // every fact depend on a path nothing ever touches.
    expect(filesNamedIn('Start with `cairn check "<subject>"`, then `npm test`.')).toEqual([])
  })

  it('ignores a repo slug, which looks exactly like a short path', () => {
    expect(filesNamedIn('The remote is `montytorr/cairn` on GitHub.')).toEqual([])
  })

  it('does not invent files from prose', () => {
    expect(filesNamedIn('The service-role client bypasses RLS, so filter by owner.')).toEqual([])
  })

  it('counts a path once however often it is named', () => {
    expect(filesNamedIn('`a/b.ts` then `a/b.ts` again')).toEqual(['a/b.ts'])
  })

  it('reads a bare filename as prose, since a name without a path is ambiguous', () => {
    expect(filesNamedIn('Defined in `client.ts`.')).toEqual([])
  })
})
