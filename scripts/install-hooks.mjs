#!/usr/bin/env node
/**
 * Wires Cairn's memory hooks into the agent runtimes on this machine.
 *
 * Three mechanisms, the same three everywhere:
 *   session start  -> inject the briefing
 *   read a file    -> inject what is known about it
 *   session end    -> record what happened, checkpoint what is still held
 *
 * Idempotent: run it again after an upgrade and it replaces its own entries
 * without touching anyone else's. Every entry it owns is tagged, and tagging
 * is how it knows what is safe to replace.
 *
 * Usage: node scripts/install-hooks.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DRY = process.argv.includes('--dry-run')
const HOME = homedir()
const REPO = dirname(import.meta.dirname)

const CONTEXT = join(HOME, '.cairn', 'hooks', 'cairn-context.mjs')
const SESSION_END = join(HOME, '.cairn', 'hooks', 'cairn-session-end.mjs')

/** Marks the entries this installer owns, so re-running replaces rather than duplicates. */
const TAG = 'cairn-memory'

const log = (...a) => console.log(...a)

/**
 * The hook set, in a form that compares.
 *
 * Two files can hold the same hooks and different bytes: JSON.stringify emits
 * keys in insertion order, so rebuilding an entry moves `cairn-memory` from
 * after `timeout` to before it, and a file without a trailing newline gains
 * one. Nothing about the configuration changed; every byte of it moved.
 *
 * That is not cosmetic for Codex. It refuses to run a hook whose entry does
 * not match a `trusted_hash` under `[hooks.state]` in config.toml, so a
 * rewrite that changes nothing still takes its memory offline until somebody
 * re-trusts each entry by hand. CAIRN-167 was that failure, found the slow
 * way: the key worked, the scripts worked when run directly, and only the host
 * config was wrong.
 *
 * So: canonicalise, and do not write a file that already says this.
 */
const canonical = (settings) =>
  JSON.stringify(
    Object.entries(settings?.hooks ?? {})
      .map(([event, groups]) => [
        event,
        (groups ?? [])
          .map((g) => [
            g.matcher ?? null,
            (g.hooks ?? []).map((h) => Object.entries(h).sort(([a], [b]) => (a < b ? -1 : 1))),
          ])
          .sort(),
      ])
      .sort(),
  )

const writeJson = (path, value, before) => {
  if (canonical(before) === canonical(value)) {
    log(`  ${path} — unchanged`)
    return false
  }
  if (DRY) {
    log(`  would write ${path}`)
    return true
  }
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak-cairn`)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return true
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

// --- the hook scripts themselves -------------------------------------------

const installScripts = () => {
  if (DRY) return log(`  would copy hooks into ${dirname(CONTEXT)}`)
  mkdirSync(dirname(CONTEXT), { recursive: true })
  copyFileSync(join(REPO, 'hooks', 'cairn-context.mjs'), CONTEXT)
  copyFileSync(join(REPO, 'hooks', 'cairn-session-end.mjs'), SESSION_END)
  log(`  scripts -> ${dirname(CONTEXT)}`)
}

/**
 * An entry this installer owns.
 *
 * The tag alone is not enough. Hooks installed by hand, or by a version of
 * this script from before the tag existed, carry no tag and are invisible to
 * a filter that only looks for one -- so re-running appends a second copy
 * instead of replacing the first. That is not a cosmetic duplicate: the
 * session recorder makes a model call, and two of them fire per event.
 *
 * Found on a machine whose Claude hooks predated the tag, where the install
 * this comment was written for would have doubled every one of them.
 *
 * So recognise the script by NAME. Not by absolute path: an entry written when
 * the scripts lived somewhere else -- a different home, a checkout, a copy
 * under /opt -- still invokes the same two files, and matching the full path
 * would miss exactly the stale entry that most needs replacing. Nothing else
 * on a machine runs a file called `cairn-session-end.mjs`.
 */
const SCRIPT_NAMES = ['cairn-context.mjs', 'cairn-session-end.mjs']

const isMine = (hook) =>
  Boolean(hook?.[TAG]) ||
  (typeof hook?.command === 'string' && SCRIPT_NAMES.some((n) => hook.command.includes(n)))

const isSafeHookCli = (value) => /^[A-Za-z0-9_./:+-]+$/.test(value)

const canonicalHermesHooks = (hooks) =>
  JSON.stringify(
    Object.entries(hooks ?? {})
      .map(([event, entries]) => [
        event,
        (Array.isArray(entries) ? entries : [])
          .map((entry) => Object.entries(entry ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))
          .sort(),
      ])
      .sort(),
  )

// --- Claude Code ------------------------------------------------------------

/**
 * Claude Code has a real SessionEnd, and for a long time that was taken to mean
 * it needed nothing else. It does.
 *
 * A session is written when it ends, and a session that runs for days does not
 * end. On the machine this was found on, four transcripts had been open since
 * 2026-09-18 -- one of them 39 MB -- and the last session recorded from that
 * host was the minute those four began, 54 hours earlier. Nothing was broken:
 * the hooks fired, the key authenticated, the parser worked. The trigger simply
 * never came.
 *
 * So PreCompact as well. A long session compacts repeatedly, and compaction is
 * the one event that is guaranteed to happen to a session too long to end --
 * it is what happens INSTEAD of ending. Recording there costs nothing extra in
 * correctness, because `cairn session end` upserts on (platform, id): the row
 * is rewritten in place, progressively richer, and the compaction that finally
 * precedes a real SessionEnd just writes the same row once more.
 *
 * This is also what makes the Codex arrangement below safe, and it has been
 * running that way all along -- Stop fires every turn and has never duplicated
 * a row.
 */
const installClaude = () => {
  const path = join(HOME, '.claude', 'settings.json')
  if (!existsSync(path)) return log('  no ~/.claude/settings.json — skipped')

  // Read twice: `settings` is mutated below, so the second copy is the only
  // record of what the file said before this run.
  const before = readJson(path)
  const settings = readJson(path)
  settings.hooks ??= {}

  const mine = (command, extra = {}) => ({ type: 'command', command, [TAG]: true, ...extra })

  const replace = (event, matcher, entry) => {
    const groups = (settings.hooks[event] ?? []).filter(
      (g) => !(g.hooks ?? []).some(isMine),
    )
    groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] })
    settings.hooks[event] = groups
  }

  replace('SessionStart', 'startup|resume|clear|compact', mine(`node ${CONTEXT}`, { timeout: 10 }))
  replace('PreToolUse', 'Read', mine(`node ${CONTEXT}`, { timeout: 10, async: true }))
  replace('SessionEnd', null, mine(`node ${SESSION_END}`, { timeout: 120, async: true }))
  // No matcher: both `manual` and `auto` compactions are the same event to us,
  // and naming them would only add a spelling to get wrong.
  replace('PreCompact', null, mine(`node ${SESSION_END}`, { timeout: 120, async: true }))

  if (writeJson(path, settings, before)) {
    log('  claude: SessionStart, PreToolUse(Read), SessionEnd, PreCompact')
  }
}

// --- Codex ------------------------------------------------------------------

/**
 * Codex shares Claude Code's wire format exactly, so the same scripts serve it.
 * Two differences that matter: there is no SessionEnd, so the recorder runs on
 * Stop and leans on the API being idempotent; and every handler has to be
 * trusted in config.toml before it runs, which this cannot do for you.
 */
const installCodex = () => {
  const path = join(HOME, '.codex', 'hooks.json')
  if (!existsSync(join(HOME, '.codex'))) return log('  no ~/.codex — skipped')

  const before = readJson(path)
  const config = readJson(path)
  config.hooks ??= {}

  const mine = (command, extra = {}) => ({ type: 'command', command, [TAG]: true, ...extra })

  const replace = (event, matcher, entry) => {
    const groups = (config.hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some(isMine))
    groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] })
    config.hooks[event] = groups
  }

  // CAIRN_AGENT names the runtime, and the CLI picks the matching key out of
  // ~/.cairn/env. Without it every runtime on a machine shares one key, and
  // the key is the identity -- which is how one host had Codex's work all
  // filed under OpenClaw's name.
  const env = 'CAIRN_AGENT=codex CAIRN_PLATFORM=codex'

  replace('SessionStart', 'startup|resume|clear', mine(`${env} node ${CONTEXT}`, { timeout: 10 }))
  replace('PreToolUse', 'Read', mine(`${env} node ${CONTEXT}`, { timeout: 10, async: true }))
  replace('Stop', null, mine(`${env} node ${SESSION_END}`, { timeout: 120, async: true }))

  // The trust warning is printed only when the file actually moved. Printed
  // every run it is wallpaper, and the one run where it matters reads the same
  // as the twenty where it did not.
  if (writeJson(path, config, before)) {
    log('  codex: SessionStart, PreToolUse(Read), Stop')
    log('  codex: entries must be trusted on next launch — [hooks.state] in config.toml')
    log('  codex: needs CAIRN_API_KEY_CODEX in ~/.cairn/env, or it writes as whoever')
    log('         owns the plain CAIRN_API_KEY there')
  }
}

// --- Hermes Agent by Nous Research ------------------------------------------

/**
 * Hermes Agent by Nous Research can return injected context only from
 * pre_llm_call; on_session_start runs once but ignores hook output. The context
 * hook checks extra.is_first_turn, making pre_llm_call a session briefing rather
 * than a cache-breaking query on every turn.
 *
 * Hermes owns atomic config.yaml writes and hook consent. Merge through its CLI
 * and never pre-approve a hook: interactive Hermes asks on first use, while
 * unattended sessions require an explicit operator opt-in.
 */
const installHermes = () => {
  let before
  try {
    const raw = execFileSync('hermes', ['config', 'get', 'hooks', '--json'], { encoding: 'utf8' }).trim()
    before = raw ? JSON.parse(raw) : {}
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return log('  Hermes Agent by Nous Research: not installed — skipped')
    }
    console.error('  Hermes Agent by Nous Research: hooks configuration is unavailable; requires Hermes Agent by Nous Research v0.21.3 or newer with `hermes config get/set` support')
    process.exitCode = 1
    return
  }
  if (!before || Array.isArray(before) || typeof before !== 'object') {
    console.error('  Hermes Agent by Nous Research: hooks configuration is not a mapping; requires Hermes Agent by Nous Research v0.21.3 or newer')
    process.exitCode = 1
    return
  }

  const hookCli = process.env.CAIRN_HOOK_CLI?.trim() || 'cairn'
  if (!isSafeHookCli(hookCli)) {
    console.error('  Hermes Agent by Nous Research: CAIRN_HOOK_CLI must be one safe executable path; refusing to write a hook that would not run')
    process.exitCode = 1
    return
  }

  const hooks = JSON.parse(JSON.stringify(before))
  const command = `env CAIRN_AGENT=hermes CAIRN_PLATFORM=hermes CAIRN_CLI=${hookCli} node ${CONTEXT}`
  const current = Array.isArray(hooks.pre_llm_call) ? hooks.pre_llm_call : []
  hooks.pre_llm_call = [...current.filter((entry) => !isMine(entry)), { command, timeout: 10 }]

  if (canonicalHermesHooks(before) === canonicalHermesHooks(hooks)) {
    return log('  Hermes Agent by Nous Research: pre_llm_call — unchanged')
  }
  if (DRY) return log('  Hermes Agent by Nous Research: would configure pre_llm_call')

  try {
    execFileSync('hermes', ['config', 'set', '--force', 'hooks', JSON.stringify(hooks)], { stdio: 'inherit' })
  } catch {
    console.error('  Hermes Agent by Nous Research: could not update hooks configuration; requires Hermes Agent by Nous Research v0.21.3 or newer with `hermes config get/set` support')
    process.exitCode = 1
    return
  }

  // A zero exit from `config set` is a claim, not a result. No Hermes runs on
  // any machine here, so every promise this installer makes about it rests on
  // reading back what it wrote rather than trusting the status it was handed.
  if (!hermesHookInstalled()) {
    console.error('  Hermes Agent by Nous Research: `hermes config set` reported success but the hook is not in the config it reads back — nothing was installed')
    process.exitCode = 1
    return
  }

  log('  Hermes Agent by Nous Research: pre_llm_call (briefing on first turn)')
  log('  Hermes Agent by Nous Research: approve the hook on first use; the installer never auto-accepts it')
}

/** Re-read the hooks config and confirm our pre_llm_call entry survived the write. */
const hermesHookInstalled = () => {
  try {
    const raw = execFileSync('hermes', ['config', 'get', 'hooks', '--json'], { encoding: 'utf8' }).trim()
    const after = raw ? JSON.parse(raw) : {}
    return Array.isArray(after.pre_llm_call) && after.pre_llm_call.some(isMine)
  } catch {
    return false
  }
}

// --- OpenClaw ---------------------------------------------------------------

/**
 * OpenClaw has no injectable session-start event; what it has is
 * `agent:bootstrap` with a mutable bootstrapFiles list. So the instruction is
 * to extend whatever bootstrap hook that installation already has rather than
 * add another, and there is no path here that would be right for two machines.
 */
const openclawNotes = () => {
  log('  openclaw: manual — extend the handler behind `agent:bootstrap`')
  log('            in your own clawd tree; there is no path to install to')
  log('            push `cairn context --project <KEY>` output as a bootstrap file')
  log('            and schedule `cairn reconcile` via `openclaw automations`')
  log('            it has no session-end event either, so sweep its transcripts:')
  log('            `cairn-session-end.mjs --scan <its sessions dir>` on a timer')
  log('            export CAIRN_AGENT=openclaw where it is launched, so a box')
  log('            it shares with Codex still attributes writes correctly')
}

const version = () => {
  const cli = process.env.CAIRN_HOOK_CLI?.trim() || 'cairn'
  if (!isSafeHookCli(cli)) return 'CAIRN_HOOK_CLI must be one safe executable path'
  try {
    return execFileSync(cli, ['--help'], { encoding: 'utf8' }).split('\n')[0]
  } catch {
    return `${cli} CLI not on PATH — install it first`
  }
}

log(`Installing Cairn memory hooks${DRY ? ' (dry run)' : ''}`)
log(`  ${version()}`)
installScripts()
installClaude()
installCodex()
installHermes()
openclawNotes()
