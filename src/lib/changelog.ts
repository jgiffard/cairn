export type Release = {
  /** `0.14.4`, or `Unreleased`. */
  version: string
  date: string | null
  body: string
}

const HEADING = /^## \[([^\]]+)\](?:\s+[—–-]\s+(\S+))?\s*$/
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S+\s*$/

/**
 * CHANGELOG.md as releases, newest first.
 *
 * Split on the `## [x.y.z] — date` headings rather than rendered whole: the
 * page draws its own heading per release, and the reference definitions at the
 * foot of the file (`[0.14.4]: …/compare/…`) would otherwise print as text
 * under whichever release came last. An empty Unreleased section is dropped.
 */
export const parseChangelog = (text: string) => {
  const lines = text.split('\n').filter((line) => !LINK_DEFINITION.test(line))
  const intro: string[] = []
  const releases: Release[] = []

  for (const line of lines) {
    const heading = line.match(HEADING)
    const last = releases.at(-1)
    if (heading?.[1]) {
      releases.push({ version: heading[1], date: heading[2] ?? null, body: '' })
    } else if (last) {
      last.body += `${line}\n`
    } else if (!line.startsWith('# ')) {
      intro.push(line)
    }
  }

  return {
    intro: intro.join('\n').trim(),
    releases: releases
      .map((r) => ({ ...r, body: r.body.trim() }))
      .filter((r) => r.version !== 'Unreleased' || r.body),
  }
}
