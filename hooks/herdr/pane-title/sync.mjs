#!/usr/bin/env node
/**
 * Mirror each agent pane's title into its Herdr labels.
 *
 *   pane rename             -> one line on the pane border
 *   report-metadata --token -> $title_l1 / $title_l2 rows in the sidebar
 *
 *   tab rename              -> the tab shows its focused agent pane's title
 *
 * The title is, in order: the Cairn task the pane's agent holds (the
 * `cairn_task` token the CLI publishes), the agent's own session title, the
 * terminal title, the agent name.
 *
 * A full sync over every pane and tab, so it does not care which one triggered
 * it, and only changed values are written. Always exits 0: a label is never
 * worth a failed hook. Widths: see readLimits.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIMIT_DEFAULTS = { paneTitleMax: 44, sidebarTitleWidth: 24, tabTitleMax: 28 }
const LIMIT_ENV = { paneTitleMax: 'HERDR_PANE_TITLE_MAX', sidebarTitleWidth: 'HERDR_SIDEBAR_TITLE_WIDTH', tabTitleMax: 'HERDR_TAB_TITLE_MAX' }

/**
 * Widths from config.json in the plugin's config dir, else the environment, else
 * the defaults. The plugin runs under the Herdr server, not the person's shell, so
 * the file is the setting that reliably reaches it.
 */
export const readLimits = (env = process.env, read = (file) => readFileSync(file, 'utf8')) => {
  let file = {}
  if (env.HERDR_PLUGIN_CONFIG_DIR) {
    try { file = JSON.parse(read(join(env.HERDR_PLUGIN_CONFIG_DIR, 'config.json'))) ?? {} } catch { /* none */ }
  }
  const limits = {}
  for (const [key, fallback] of Object.entries(LIMIT_DEFAULTS)) {
    const value = [file[key], env[LIMIT_ENV[key]]].map(Number).find((n) => Number.isInteger(n) && n >= 8)
    limits[key] = value ?? fallback
  }
  return limits
}

const LIMITS = readLimits()
const SOURCE = 'cairn.pane-title'
const TIMEOUT_MS = 5000
const SCAN_MAX_BYTES = 4 * 1024 * 1024

let heldLock = null

const herdr = (...args) => {
  // the lock goes stale on idleness, not age: a slow Herdr must not let a second sync in
  if (heldLock) try { const now = new Date(); utimesSync(heldLock, now, now) } catch { /* checked on the next acquire */ }
  return execFileSync('herdr', args, { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Truncate on a word boundary rather than mid-word. */
export const cutOneLine = (text, width) => {
  if (text.length <= width) return text
  let head = text.slice(0, width - 1)
  const space = head.lastIndexOf(' ')
  if (text[width - 1] !== ' ' && space >= Math.floor(width / 2)) head = head.slice(0, space)
  return `${head.replace(/[ ,;:-]+$/, '')}…`
}

/** Wrap over two rows, as evenly as the width allows. */
export const splitTwo = (text, width) => {
  if (text.length <= width) return [text, '']
  const words = text.split(/\s+/).filter(Boolean)
  let best = null
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    if (a.length <= width && b.length <= width) {
      const score = Math.abs(a.length - b.length)
      if (!best || score < best.score) best = { score, a, b }
    }
  }
  if (best) return [best.a, best.b]

  // Too long for two rows: fill greedily and let the ellipsis do the rest.
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= width) { line = next; continue }
    if (line) lines.push(line)
    line = word.length > width ? word.slice(0, width) : word
  }
  if (line) lines.push(line)
  if (lines.length <= 2) return [lines[0] ?? '', lines[1] ?? '']
  let second = lines.slice(1).join(' ')
  while (second.length + 1 > width && second.includes(' ')) second = second.slice(0, second.lastIndexOf(' '))
  return [lines[0], `${second.slice(0, width - 1)}…`]
}

/** First non-empty result of pick() over a jsonl file, read in chunks: rollouts run to megabytes. */
const scan = (path, pick) => {
  let fd
  try {
    fd = openSync(path, 'r')
    const chunk = Buffer.alloc(64 * 1024)
    let pending = ''
    let read = 0
    let more = true
    while (more) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      more = n > 0 && read <= SCAN_MAX_BYTES
      read += n
      pending += chunk.toString('utf8', 0, n)
      const lines = pending.split('\n')
      pending = more ? (lines.pop() ?? '') : ''
      for (const line of lines) {
        let got = ''
        try { got = pick(JSON.parse(line)) } catch { continue }
        if (got) return got.split(/\s+/).filter(Boolean).join(' ')
      }
    }
  } catch { /* unreadable or gone: no title */ } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return ''
}

/**
 * Codex titles its terminal after the cwd, which says nothing. Its rollout file
 * is named after the session id Herdr reports, so read the first real user
 * prompt out of it: the opening message is the AGENTS.md preamble.
 */
export const codexTitle = (session, home = homedir()) => {
  const root = join(home, '.codex', 'sessions')
  let name
  try {
    name = readdirSync(root, { recursive: true }).find((f) => {
      const base = String(f).split('/').pop() ?? ''
      return base.startsWith('rollout-') && base.endsWith(`${session}.jsonl`)
    })
  } catch { return '' }
  if (!name) return ''
  return scan(join(root, String(name)), (record) => {
    const payload = record?.payload ?? {}
    return record?.type === 'event_msg' && payload.type === 'user_message' ? payload.message || '' : ''
  })
}

/** Pi reports its session as a direct path, so no lookup is needed. */
export const piTitle = (session) =>
  scan(session, (record) => {
    const message = record?.message ?? {}
    if (record?.type !== 'message' || message.role !== 'user') return ''
    return (message.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text || '').join(' ')
  })

const RESOLVERS = { codex: codexTitle, pi: piTitle }

const resolvedTitle = (pane, agent) => {
  const resolver = RESOLVERS[agent]
  const session = pane.agent_session?.value
  if (!resolver || !session) return ''
  try { return resolver(session) } catch { return '' }
}

/** The Cairn task, else the agent's session title, else the terminal title, else the agent name. */
export const pickTitle = (pane, resolved = '') => {
  const agent = (pane.agent ?? '').trim()
  return (
    (pane.tokens?.cairn_task ?? '').trim() ||
    resolved.trim() ||
    (pane.terminal_title_stripped ?? '').trim() ||
    agent
  )
}

const syncPane = (pane, title) => {
  const border = cutOneLine(title, LIMITS.paneTitleMax)
  if ((pane.label ?? '') !== border) herdr('pane', 'rename', pane.pane_id, border)

  const [l1, l2] = splitTwo(title, LIMITS.sidebarTitleWidth)
  const tokens = pane.tokens ?? {}
  if ((tokens.title_l1 ?? '') === l1 && (tokens.title_l2 ?? '') === l2) return

  // An empty second row is cleared, not blanked: Herdr hides valueless rows.
  herdr('pane', 'report-metadata', pane.pane_id, '--source', SOURCE, '--token', `title_l1=${l1}`,
    ...(l2 ? ['--token', `title_l2=${l2}`] : ['--clear-token', 'title_l2']))
}

/**
 * The label a tab should carry, or null to leave it alone.
 *
 * Herdr's default tab label is its number, so that, an empty label, or the
 * label this plugin last wrote is ours to replace. Anything else was typed by
 * a person and stays. A focused plain shell says nothing worth showing.
 */
export const tabLabel = (tab, focusedPane, title, last, max = LIMITS.tabTitleMax) => {
  if (!focusedPane?.agent || !title) return null
  const current = tab.label ?? ''
  if (current !== '' && current !== String(tab.number) && current !== last) return null
  const label = cutOneLine(title, max)
  return label === current ? null : label
}

/** The pane a tab has focus on: the only one, else what its layout says (focus is tracked per tab, not just for the visible one). */
export const focusedPaneOf = (tabPanes, focusedId) => {
  if (tabPanes.length <= 1) return tabPanes[0] ?? null
  const id = focusedId(tabPanes[0])
  return tabPanes.find((p) => p.pane_id === id) ?? tabPanes.find((p) => p.focused) ?? null
}

const layoutFocus = (pane) => {
  try { return JSON.parse(herdr('pane', 'layout', '--pane', pane.pane_id)).result.layout.focused_pane_id } catch { return null }
}

/** What this plugin wrote, so it can undo its panes and tell its tab labels from a person's. */
const statePath = () => join(process.env.HERDR_PLUGIN_STATE_DIR || join(homedir(), '.cairn', 'herdr'), 'state.json')

const loadState = () => {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    return { panes: new Set(raw.panes ?? []), tabs: raw.tabs ?? {} }
  } catch { return { panes: new Set(), tabs: {} } }
}

const saveState = (state) => {
  try {
    mkdirSync(join(statePath(), '..'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify({ panes: [...state.panes], tabs: state.tabs }))
  } catch { /* the next sync rebuilds it */ }
}

const release = (pane) => {
  herdr('pane', 'rename', pane.pane_id, '--clear')
  herdr('pane', 'report-metadata', pane.pane_id, '--source', SOURCE, '--clear-token', 'title_l1', '--clear-token', 'title_l2')
}

const syncTabs = (panes, titles, before) => {
  let tabs
  try { tabs = JSON.parse(herdr('tab', 'list')).result.tabs } catch { return before.tabs }
  const written = {}
  for (const tab of tabs) {
    const last = before.tabs[tab.tab_id]
    if (last !== undefined) written[tab.tab_id] = last
    try {
      const focused = focusedPaneOf(panes.filter((p) => p.tab_id === tab.tab_id), layoutFocus)
      const label = tabLabel(tab, focused, focused ? titles.get(focused.pane_id) : '', last)
      if (label === null) continue
      herdr('tab', 'rename', tab.tab_id, label)
      written[tab.tab_id] = label
    } catch { /* one tab must not stop the others */ }
  }
  return written
}

export const main = () => {
  let panes
  try { panes = JSON.parse(herdr('pane', 'list')).result.panes } catch { return 0 }

  const before = loadState()
  const titled = new Set()
  const titles = new Map()
  for (const pane of panes) {
    try {
      if (pane.agent) {
        titles.set(pane.pane_id, pickTitle(pane, resolvedTitle(pane, pane.agent.trim())))
        titled.add(pane.pane_id)
        if (titles.get(pane.pane_id)) syncPane(pane, titles.get(pane.pane_id))
      } else if (before.panes.has(pane.pane_id)) {
        release(pane)
      }
    } catch {
      if (before.panes.has(pane.pane_id)) titled.add(pane.pane_id)
    }
  }
  saveState({ panes: titled, tabs: syncTabs(panes, titles, before) })
  return 0
}

/** Untouched for this long, a lock was left by a sync that died. */
const LOCK_STALE_MS = 60_000

const acquire = (lock) => {
  try { mkdirSync(lock); return true } catch { /* held, or stale */ }
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock)
    return true
  } catch { return false }
}

/**
 * Every event starts its own process, and each sync rewrites state.json whole,
 * so two at once lose each other's entries. One sync runs at a time; an event
 * that finds it busy leaves a mark and the running sync goes round once more,
 * so the last event is never lost.
 */
export const runExclusive = (sync, dir = dirname(statePath())) => {
  const lock = join(dir, 'sync.lock')
  const pending = join(dir, 'sync.pending')
  try { mkdirSync(dir, { recursive: true }) } catch { /* acquire fails below */ }
  for (let round = 0; round < 5; round += 1) {
    if (!acquire(lock)) {
      try { writeFileSync(pending, '') } catch { /* nothing more to do */ }
      // the holder may have finished between the failed acquire and the mark
      if (!acquire(lock)) return
    }
    heldLock = lock
    try {
      rmSync(pending, { force: true })
      sync()
    } catch { /* a label is never worth a failed hook */ } finally {
      heldLock = null
      rmSync(lock, { recursive: true, force: true })
    }
    if (!existsSync(pending)) return
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runExclusive(main) } catch { /* always exit 0 */ }
  process.exitCode = 0
}
