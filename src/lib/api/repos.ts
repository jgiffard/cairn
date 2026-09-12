/**
 * Repository identity, which is what "which project is this?" really asks.
 *
 * A path answers where one machine keeps a checkout; it changes under a second
 * clone, a `mv` and a `git worktree`, none of which change the repository. The
 * remote does not, and it costs one local git call to read.
 */

/**
 * git@github.com:montytorr/cairn.git, https://github.com/montytorr/cairn.git
 * and https://user:token@github.com/montytorr/cairn/ are one repository.
 *
 * Normalising on the server keeps the rule in one place, so the CLI, the MCP
 * facade and an import all reach the same row. Everything stripped here is
 * transport — how this checkout reaches the repo — rather than identity.
 */
export const normaliseRemote = (raw: string): string =>
  raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    .replace(/^[^@/]+@/, '') // credentials, or the ssh user
    .replace(/:\d+(?=\/|$)/, '') // port
    .replace(/:/, '/') // scp-style host:path
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()

type RepoRow = { project: { key: string } | { key: string }[] | null }

/**
 * Ambiguity is left unresolved on purpose. A monorepo whose subdirectories are
 * separate projects matches more than once, and guessing between them would be
 * silently wrong for months; returning nothing lets the caller's own answer —
 * an explicit `--project`, or the local map — decide instead.
 */
export const projectKeyFromRepoRows = (rows: RepoRow[]): string | null => {
  const row = rows.length === 1 ? rows[0] : undefined
  if (!row) return null
  const embedded = row.project
  return (Array.isArray(embedded) ? embedded[0]?.key : embedded?.key) ?? null
}
