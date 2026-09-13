#!/usr/bin/env node
/**
 * Cairn's scheduled maintenance, as something you can read in a pull request.
 *
 * These jobs are OPTIONAL. Cairn works without any of them: they are the
 * difference between a tracker that notices its own problems and one that
 * waits to be asked. Install none, some, or all.
 *
 *   node scripts/install-cron.mjs            # print what would be installed
 *   node scripts/install-cron.mjs --install  # install it
 *   node scripts/install-cron.mjs --remove   # take it out again
 *
 * Printing is the default on purpose: a script that edits a crontab the moment
 * it is run is a script nobody should run.
 *
 * cron on Linux, launchd on macOS. The jobs are defined once, as a schedule, an
 * environment and a command; each backend renders that. A second definition
 * would be a second thing to keep in step, which is the failure this file
 * exists to end — the jobs used to live only in the crontab on one box.
 *
 * Cairn's lines live between two markers and the installer only ever touches
 * what is between them. The manual edits these replace filtered the crontab by
 * grepping for the previous command, which worked and was one bad pattern away
 * from dropping eighteen lines of unrelated scheduling.
 *
 * Host-specific paths come from the environment, because a machine's layout
 * does not belong in a public repository. Any job whose prerequisites are not
 * present on this machine is skipped rather than installed broken.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEGIN = '# >>> cairn maintenance (managed by scripts/install-cron.mjs)'
const END = '# <<< cairn maintenance'

const HERE = dirname(fileURLToPath(import.meta.url))

const env = (name, fallback) => process.env[name] ?? fallback

const MAC = process.platform === 'darwin'

/**
 * Defaults that describe the machine this is running on rather than one host.
 *
 * A Mac has no /usr/local/bin/cairn, cannot write /var/log as the logged-in
 * user, and keeps node wherever Homebrew or nvm put it — so the Linux defaults
 * made every job skip, correctly but uselessly.
 */
const firstPresent = (...paths) => paths.find((path) => existsSync(path)) ?? paths[paths.length - 1]

const CLI = env(
  'CAIRN_CLI_PATH',
  firstPresent(join(homedir(), '.local/bin/cairn'), '/usr/local/bin/cairn'),
)
// process.execPath is the node actually running this, which is the one that
// will still be there tomorrow. Pinned on Linux, where /usr/bin/node is what
// the installed crontabs already name.
const NODE = env('CAIRN_NODE_PATH', MAC ? process.execPath : '/usr/bin/node')
const LOGS = env('CAIRN_LOG_DIR', MAC ? join(homedir(), 'Library/Logs') : '/var/log')
const SYNC = env(
  'CAIRN_SYNC_SCRIPT',
  MAC
    ? join(homedir(), '.cairn/maintenance/sync-agent-files.mjs')
    : '/opt/cairn-maintenance/sync-agent-files.mjs',
)
const RAW = env('CAIRN_RAW_BASE', 'https://raw.githubusercontent.com/montytorr/cairn/main')
const HOOKS = env('CAIRN_HOOKS_DIR', join(homedir(), '.cairn/hooks'))

/** Where a runtime keeps transcripts nothing else will hand us. */
const OPENCLAW_SESSIONS = env('CAIRN_OPENCLAW_SESSIONS', '')

/** Tasks the jobs report into. Empty disables reporting for that job. */
const NOTIFY_FILES = env('CAIRN_NOTIFY_FILES', '')
const NOTIFY_VITALS = env('CAIRN_NOTIFY_VITALS', '')

/** Extra copies outside this user's home, as `artefact=path`, comma separated. */
const ALSO = env('CAIRN_SYNC_ALSO', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const log = (name) => join(LOGS, `cairn-${name}.log`)

/**
 * The jobs, as schedule + environment + command.
 *
 * Rendered into a crontab line or a launchd plist below. Written this way so
 * the two backends cannot disagree about what a job actually is.
 */
const JOBS = [
  {
    name: 'reconcile',
    why: 'Releases claims an agent stopped working on, and moves the task back to todo.',
    requires: [CLI],
    every: 30,
    env: { CAIRN_AGENT: 'maintenance' },
    command: [CLI, 'reconcile'],
  },
  {
    name: 'vitals',
    why: 'Asks daily whether the memory is still being written, and says so only when it is not.',
    requires: [CLI],
    at: { hour: 8, minute: 0 },
    env: { CAIRN_AGENT: 'maintenance' },
    command: [CLI, 'vitals', ...(NOTIFY_VITALS ? ['--notify', NOTIFY_VITALS] : [])],
  },
  {
    name: 'agent-files',
    why: 'Repairs the skill, CLI and hooks wherever a runtime reads a stale copy.',
    requires: [SYNC, NODE],
    at: { minute: 23 },
    env: { CAIRN_AGENT: 'maintenance' },
    command: [
      NODE,
      SYNC,
      '--source',
      RAW,
      ...ALSO.flatMap((pair) => ['--also', pair]),
      ...(NOTIFY_FILES ? ['--notify', NOTIFY_FILES] : []),
    ],
  },
  {
    name: 'openclaw-sessions',
    why: 'OpenClaw has no session-end event, so its transcripts are swept instead.',
    requires: [OPENCLAW_SESSIONS, join(HOOKS, 'cairn-session-end.mjs'), NODE],
    every: 30,
    env: { CAIRN_AGENT: 'openclaw', CAIRN_PLATFORM: 'openclaw' },
    command: [NODE, join(HOOKS, 'cairn-session-end.mjs'), '--scan', OPENCLAW_SESSIONS],
  },
]

// Every N minutes, a daily time, or a minute past each hour.
const cronFields = (job) =>
  job.every
    ? `*/${job.every} * * * *`
    : `${job.at.minute ?? 0} ${job.at.hour ?? '*'} * * *`

const cronLine = (job) =>
  `${cronFields(job)} ` +
  Object.entries(job.env).map(([k, v]) => `${k}=${v}`).join(' ') +
  ` ${job.command.join(' ')} >> ${log(job.name)} 2>&1`

// ---------------------------------------------------------------------------
// launchd, for macOS. Same jobs, rendered as one agent per job.
//
// Not cron: macOS still has a crontab, but it is deprecated, it runs outside
// the user session where a job cannot reach the keychain or a per-user PATH,
// and it is subject to privacy prompts nobody is present to answer. A
// LaunchAgent runs as the logged-in user, which is whose files these are.
// ---------------------------------------------------------------------------

const LABEL = (name) => `com.cairn.${name}`
const AGENTS_DIR = join(homedir(), 'Library/LaunchAgents')
const plistPath = (name) => join(AGENTS_DIR, `${LABEL(name)}.plist`)

const xml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * launchd has no "every 30 minutes", only a list of times — so the interval is
 * expanded into the minutes it actually means.
 */
const calendar = (job) =>
  job.every
    ? Array.from({ length: Math.floor(60 / job.every) }, (_, i) => ({ Minute: i * job.every }))
    : [{ ...(job.at.hour === undefined ? {} : { Hour: job.at.hour }), Minute: job.at.minute ?? 0 }]

/**
 * A LaunchAgent inherits almost no environment, so the PATH a job needs has to
 * be stated. sync-agent-files reports by calling `cairn`, which is on nobody's
 * PATH under launchd.
 */
const jobPath = [dirname(CLI), dirname(NODE), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  .filter((dir, i, all) => all.indexOf(dir) === i)
  .join(':')

const plist = (job) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL(job.name)}</string>
  <key>ProgramArguments</key>
  <array>
${job.command.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(job.env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
    <key>PATH</key><string>${xml(jobPath)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${calendar(job)
  .map(
    (slot) =>
      `    <dict>${Object.entries(slot)
        .map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`)
        .join('')}</dict>`,
  )
  .join('\n')}
  </array>
  <key>StandardOutPath</key><string>${xml(log(job.name))}</string>
  <key>StandardErrorPath</key><string>${xml(log(job.name))}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`

const launchctl = (args, { tolerate = false } = {}) => {
  try {
    execFileSync('launchctl', args, { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch (error) {
    // bootout on something not loaded is the normal case on a first install.
    if (!tolerate) throw error
  }
}

const only = process.argv.includes('--only')
  ? (process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',')
  : null

const REMOVE = process.argv.includes('--remove')
const INSTALL = process.argv.includes('--install')
const USE_LAUNCHD = process.argv.includes('--launchd') || (MAC && !process.argv.includes('--cron'))

/**
 * The repairer has to be somewhere stable before it can be scheduled: a job
 * pointed at a working tree breaks the first time the tree is moved or checked
 * out to a branch. On the server this directory was made by hand; doing it here
 * is what makes `--install` work on a machine that has never had it.
 */
const REPO_SYNC = join(HERE, 'sync-agent-files.mjs')
if (INSTALL && !existsSync(SYNC) && existsSync(REPO_SYNC)) {
  mkdirSync(dirname(SYNC), { recursive: true })
  copyFileSync(REPO_SYNC, SYNC)
  console.log(`placed ${SYNC}`)
}

const applicable = JOBS.filter((job) => {
  if (only && !only.includes(job.name)) return false
  // An empty requirement is one the environment never named — a job that was
  // not configured rather than one whose file is missing. Reported as itself,
  // because "no  on this machine" reads like a bug in the installer.
  const unset = job.requires.filter((path) => !path)
  if (unset.length > 0) {
    console.error(`# skipping ${job.name}: not configured on this machine`)
    return false
  }
  const missing = job.requires.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    console.error(`# skipping ${job.name}: no ${missing[0]} on this machine`)
    return false
  }
  return true
})

const block = [BEGIN, ...applicable.flatMap((job) => [`# ${job.name}: ${job.why}`, cronLine(job)]), END]

const current = () => {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8' })
  } catch {
    return '' // no crontab yet is not an error
  }
}

/** Everything that is not ours, with our block cut out wherever it sits. */
const withoutOurs = (text) => {
  const lines = text.split('\n')
  const start = lines.indexOf(BEGIN)
  const end = lines.indexOf(END)
  if (start === -1 || end === -1 || end < start) return lines
  return [...lines.slice(0, start), ...lines.slice(end + 1)]
}

if (!INSTALL && !REMOVE) {
  if (USE_LAUNCHD) {
    console.log(`# launchd — ${applicable.length} agent(s) in ${AGENTS_DIR}\n`)
    for (const job of applicable) console.log(`# ${job.name}: ${job.why}\n${plist(job)}`)
  } else {
    console.log(block.join('\n'))
  }
  console.log('\n# nothing written. --install to apply, --remove to take it out.')
  process.exit(0)
}

if (USE_LAUNCHD) {
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  const uid = process.getuid()

  // Every job is torn down first, including on install: a plist that changed
  // under a loaded agent is not picked up, and the stale one goes on running.
  for (const job of JOBS) {
    launchctl(['bootout', `gui/${uid}/${LABEL(job.name)}`], { tolerate: true })
    if (REMOVE) rmSync(plistPath(job.name), { force: true })
  }

  if (REMOVE) {
    console.log(`removed ${JOBS.length} agent(s) from ${AGENTS_DIR}`)
    process.exit(0)
  }

  for (const job of applicable) {
    writeFileSync(plistPath(job.name), plist(job), { mode: 0o644 })
    launchctl(['bootstrap', `gui/${uid}`, plistPath(job.name)])
    console.log(`loaded ${LABEL(job.name)}  (${job.name})`)
  }
  console.log(`installed ${applicable.length} agent(s); logs in ${LOGS}`)
  process.exit(0)
}

const existing = current()

// A crontab is somebody's scheduling, and this rewrites the whole of it.
const backup = join(homedir(), `crontab.bak-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`)
writeFileSync(backup, existing, { mode: 0o600 })
console.log(`backed up to ${backup}`)

/** `crontab -l` ends in a newline, so the split leaves a trailing empty line.
 *  Cutting our block out of the middle moved that empty line up against the
 *  block we then appended, and one blank line was added on every run. */
const trimEnd = (lines) => {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

const kept = trimEnd(withoutOurs(existing))
const next = trimEnd(REMOVE ? kept : [...kept, ...block])

execFileSync('crontab', ['-'], { input: `${next.join('\n')}\n` })
console.log(REMOVE ? 'removed' : `installed ${applicable.length} job(s)`)
