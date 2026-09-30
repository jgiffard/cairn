/**
 * What `cairn setup` does about the Herdr pane-title plugin, as decisions
 * over data, so a re-run can be reasoned about (and tested) without Herdr.
 *
 * The plugin is linked from a copy under ~/.cairn/hooks/herdr/pane-title, so an
 * upgrade is a changed copy and nothing else. `herdr plugin list --json` is the
 * only source of truth for what is installed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const PLUGIN_ID = 'cairn.pane-title'

/** `link` when Herdr does not have this copy registered at this version; `none` when it already does. */
export const planHerdrPlugin = ({ plugins, root, version }) => {
  const ours = plugins.find((p) => p.plugin_id === PLUGIN_ID)
  if (!ours) return { action: 'link', reason: 'not installed' }
  if (ours.plugin_root !== root) return { action: 'link', reason: `installed from ${ours.plugin_root}` }
  if (ours.version !== version) return { action: 'link', reason: `${ours.version} -> ${version}` }
  return { action: 'none', reason: `already linked at ${version}` }
}

/**
 * Other plugins that label panes with the same sidebar rows. Two of them fight
 * over `title_l1` / `title_l2` on every event, so setup names them and leaves
 * the decision to the person; it never removes one.
 */
export const titleConflicts = (plugins, read = readPluginFile) =>
  plugins.filter((p) => {
    if (p.plugin_id === PLUGIN_ID) return false
    const files = [p.manifest_path, ...commandFiles(p)]
    return files.some((file) => /\btitle_l[12]\b/.test(read(file) ?? ''))
  })

const commandFiles = (plugin) =>
  [...(plugin.startup ?? []), ...(plugin.events ?? []), ...(plugin.actions ?? [])]
    .flatMap((entry) => entry.command ?? [])
    .filter((arg) => /\.(py|mjs|js|sh)$/.test(arg))
    .map((arg) => (isAbsolute(arg) ? arg : join(plugin.plugin_root ?? '', arg)))

const readPluginFile = (file) => {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : null } catch { return null }
}
