/**
 * Reads the footer a Linear import leaves at the end of a task description:
 *
 *   *Imported from Linear [DIS-2237](https://linear.app/dispofi/issue/DIS-2237/slug) · ...
 *
 * Only the footer counts. A task that merely talks about DIS-2237 has no
 * footer and is not that issue.
 */

export const LINEAR_HOST = 'linear.app'

const FOOTER = /Imported from Linear \[([A-Za-z][A-Za-z0-9]*-\d+)\]\((https:\/\/linear\.app\/[^\s)]+)\)/gi
const ISSUE_IN_URL = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?=[/?#]|$)/i

/** The `external_ref` a Linear id is stored under: the `${host}/${ref}` shape `cairn handoff` writes. */
export const linearRef = (key) => `${LINEAR_HOST}/${key.toUpperCase()}`

/**
 * @param {string | null | undefined} description
 * @returns {{ key: string, url: string, footers: { key: string, url: string }[], urlKey: string | null } | null}
 *   the last footer (key upper-cased), every footer found in order, and the
 *   issue id the last URL names (null for a URL with no `/issue/KEY-n`);
 *   null when there is no footer
 */
export const parseFooter = (description) => {
  if (!description) return null
  const footers = [...description.matchAll(FOOTER)].map((m) => ({ key: m[1].toUpperCase(), url: m[2] }))
  if (!footers.length) return null
  const last = footers[footers.length - 1]
  const urlKey = ISSUE_IN_URL.exec(last.url)?.[1]?.toUpperCase() ?? null
  return { key: last.key, url: last.url, footers, urlKey }
}
