#!/usr/bin/env node
/**
 * cairn — the single implementation every agent calls.
 *
 * Deliberately dependency-free: Node 22's built-in fetch is enough, so the CLI
 * can be dropped onto a box and run without an install step. Claude Code,
 * Codex and OpenClaw all reach it the same way, through a shell.
 *
 * Output discipline is the point, not a detail. Lists are TSV with the keys
 * emitted once as a header, nulls omitted, a count-first line so the caller
 * can paginate before parsing, and — on search — an estimated token cost per
 * row so the model can decline to open something.
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Credentials come from the environment, falling back to ~/.cairn/env — so an
 * agent skill works without the user having to edit a shell profile first.
 * Format is plain KEY=value lines.
 */
const fileEnv = () => {
  try {
    const path = `${homedir()}/.cairn/env`
    if (!existsSync(path)) return {}
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

/**
 * Kept in step with package.json by a test, because this file is copied to
 * machines rather than installed from a registry: it is the copy on the box
 * that matters, and nothing else would notice it going stale. A CLI three days
 * old was found writing under the wrong identity exactly once, which was
 * enough.
 */
const VERSION = '0.5.1'

const FILE_ENV = fileEnv()
const BASE = (process.env.CAIRN_BASE_URL || FILE_ENV.CAIRN_BASE_URL || 'http://localhost:3000')
  .replace(/\/+$/, '')

/**
 * Which runtime is speaking.
 *
 * The API key IS the identity -- an actor_id comes from the key, not from
 * anything the caller says -- and one key per machine meant every runtime on
 * a host wrote as whoever owned that file — so on one machine every Codex
 * task, claim and close was filed under OpenClaw's name, and no agent could be
 * held to its own behaviour.
 *
 * Per-user key files cannot fix it either: Codex may run as more than one
 * user on the same box, and share a user with OpenClaw.
 *
 * So the runtime names itself, and the file can carry a key per runtime.
 * `CLAUDECODE` is set by Claude Code itself; the others are set where the
 * runtime is launched, which is the only place that knows.
 */
const detectAgent = () => {
  if (process.env.CAIRN_AGENT) return process.env.CAIRN_AGENT.trim().toLowerCase()
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code'

  // OpenClaw runs Codex underneath, pointed at a CODEX_HOME of its own
  // (an `.openclaw/.../codex-home` of its own). Testing for
  // Codex first would therefore file every one of OpenClaw's writes as Codex
  // -- the same misattribution this exists to fix, pointing the other way.
  const codexHome = process.env.CODEX_HOME ?? ''
  if (/openclaw/i.test(codexHome)) return 'openclaw'

  // Any OPENCLAW_* variable at all, rather than two guessed names.
  //
  // The live gateway sets OPENCLAW_SERVICE_MARKER, OPENCLAW_SYSTEMD_UNIT and
  // eight more, and none of them is OPENCLAW_SESSION or OPENCLAW_HOME — the two
  // that were checked here. The whole of OpenClaw's identity therefore rested
  // on its CODEX_HOME containing the word, and if that ever stopped being true
  // it would now fall through to the Codex markers below, which OpenClaw also
  // sets, and file every one of its writes as Codex.
  if (Object.keys(process.env).some((name) => name.startsWith('OPENCLAW_'))) return 'openclaw'

  // CODEX_MANAGED_* are set by Codex itself, and are the only markers that
  // survive being launched directly.
  //
  // Detection used to rest on CODEX_HOME, which Codex reads but does not
  // export, so /usr/local/bin/codex was installed to set it. A live session was
  // found running as `node /usr/bin/codex --yolo` with no CODEX_HOME at all —
  // the wrapper bypassed — so detection returned nothing and the CLI fell back
  // to the machine's default key, which on that host is OpenClaw's. Every
  // Codex write was filed as OpenClaw, exactly as before the wrapper existed.
  //
  // These are checked after the OpenClaw tests on purpose: OpenClaw runs Codex
  // underneath and therefore sets them too.
  if (codexHome || process.env.CODEX_SANDBOX) return 'codex'
  if (process.env.CODEX_MANAGED_BY_NPM || process.env.CODEX_MANAGED_PACKAGE_ROOT) return 'codex'
  return ''
}

const AGENT = detectAgent()

/**
 * An explicit CAIRN_API_KEY in the environment always wins -- it is how a
 * one-off command borrows another identity. Otherwise the runtime's own key is
 * preferred, and the plain one is the fallback, so a machine that has not been
 * split yet keeps working exactly as before.
 */
const keyNameFor = (agent) => `CAIRN_API_KEY_${agent.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

const OWN_KEY = AGENT ? FILE_ENV[keyNameFor(AGENT)] : undefined

const KEY = process.env.CAIRN_API_KEY || OWN_KEY || FILE_ENV.CAIRN_API_KEY || ''

/**
 * Borrowing another runtime's identity should be a decision, not an accident.
 *
 * On a machine that has been split into per-agent keys, falling back to the
 * plain one files the work under whichever agent that key belongs to. It did
 * exactly that for weeks: Codex could not be detected, so every write it made
 * was attributed to OpenClaw, and nothing anywhere said so — the statistics
 * looked fine, they were just about the wrong agent.
 *
 * A warning rather than a refusal, because the fallback is legitimate on a
 * machine that has not been split, and refusing would break it.
 */
const SPLIT_KEYS = Object.keys(FILE_ENV).filter((name) => name.startsWith('CAIRN_API_KEY_'))
if (!process.env.CAIRN_API_KEY && !OWN_KEY && SPLIT_KEYS.length > 0 && FILE_ENV.CAIRN_API_KEY) {
  process.stderr.write(
    `cairn: could not tell which runtime this is${AGENT ? ` (${AGENT} has no ${keyNameFor(AGENT)})` : ''}, ` +
      `so this write will be filed under the default key. ` +
      `Set CAIRN_AGENT, or add ${AGENT ? keyNameFor(AGENT) : 'CAIRN_API_KEY_<AGENT>'} to ~/.cairn/env.\n`,
  )
}

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    const [name, inline] = arg.slice(2).split('=')
    if (inline !== undefined) flags[name] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i]
    else flags[name] = true
  } else positional.push(arg)
}

const FORMAT = flags.json ? 'json' : flags.pretty ? 'pretty' : 'tsv'

/** `-` means read the value from stdin, so long markdown bodies stay off argv. */
const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
const resolveValue = async (v) => (v === '-' ? (await readStdin()).trim() : v)

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
/**
 * Gateway errors are transient and worth waiting out.
 *
 * A deploy takes the app down for a few seconds, and during that window every
 * call returns 502 from the proxy. That is survivable for a human retrying by
 * hand and fatal for a batch import or a session-end hook, which gets one
 * chance to record what happened before the session is gone.
 */
const TRANSIENT = new Set([502, 503, 504])
const RETRIES = 3

/**
 * How long a write may spend being retried before it is put aside instead.
 *
 * Writes normally return in about half a second. During a deploy the container
 * is down and they block for minutes — several `cairn add` calls ran past 120s
 * and 300s, every one of them while a container was restarting. Retrying is
 * right; making an agent mid-task wait for a restart is not. Cairn is supposed
 * to be the thing an agent can always write to.
 */
const DEADLINE_MS = Number(process.env.CAIRN_DEADLINE_MS ?? 15_000)

/** Guards against a replay triggering its own replay. */
let FLUSHING = false

/**
 * The outbox, and what is allowed into it.
 *
 * Only writes whose answer the caller does not need: a note, a comment, a
 * heartbeat, a checkpoint. `add` and `claim` are deliberately excluded — an
 * agent that is handed a ref which does not exist yet, or told it holds a task
 * it may not have won, is worse off than one told plainly that the write
 * failed. Those fail fast instead.
 */
const OUTBOX_PATH = join(homedir(), '.cairn', 'outbox.jsonl')
const REJECTED_OUTBOX_PATH = `${OUTBOX_PATH}.rejected`
const OUTBOX_LOCK_PATH = `${OUTBOX_PATH}.lock`
const OUTBOX_PREFIX = 'outbox.jsonl.'
const QUEUEABLE = /\/(notes|comments|beat|checkpoint)$/
const KEY_ID = KEY ? createHash('sha256').update(KEY).digest('hex').slice(0, 24) : ''
const TEST_CRASH_AFTER_SEND = process.env.CAIRN_TEST_CRASH_AFTER_SEND === '1'
const TEST_FAIL_PERSIST_AFTER_SEND = process.env.CAIRN_TEST_FAIL_PERSIST_AFTER_SEND === '1'
const TEST_CRASH_AFTER_RENAME_BEFORE_STATE = process.env.CAIRN_TEST_CRASH_AFTER_RENAME_BEFORE_STATE === '1'
const TEST_FAIL_REJECT_PERSIST = process.env.CAIRN_TEST_FAIL_REJECT_PERSIST === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Put a write aside so the agent can carry on, and say so plainly. */
const withOutboxLock = async (run) => {
  mkdirSync(dirname(OUTBOX_PATH), { recursive: true })
  const deadline = Date.now() + Math.max(DEADLINE_MS, 5_000)
  let handle
  while (handle === undefined) {
    try {
      handle = openSync(OUTBOX_LOCK_PATH, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(OUTBOX_LOCK_PATH).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)) {
          unlinkSync(OUTBOX_LOCK_PATH)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for the outbox lock')
      await sleep(20)
    }
  }
  try {
    return await run()
  } finally {
    closeSync(handle)
    try { unlinkSync(OUTBOX_LOCK_PATH) } catch { /* stale recovery may already have removed it */ }
  }
}

const enqueue = async (method, path, body, why) => {
  try {
    await withOutboxLock(() => {
      if (path.split('?')[0].endsWith('/checkpoint')) {
        const state = rememberedTaskState(path)
        if (state) body = {
          ...body,
          ownershipVersion: state.ownershipVersion,
          checkpointVersion: state.checkpointVersion + pendingCheckpointCount(path, state.ownershipVersion),
        }
      }
      const item = {
        id: randomUUID(),
        t: new Date().toISOString(),
        method,
        path,
        body,
        agent: AGENT,
        base: BASE,
        keyId: KEY_ID,
      }
      appendFileSync(OUTBOX_PATH, `${JSON.stringify(item)}\n`, { mode: 0o600 })
    })
  } catch (error) {
    die(`${why}, and it could not be queued either: ${error.message}`)
  }
  process.stderr.write(`${why} — queued locally, replays on the next successful write\n`)
  return { queued: true, path }
}

/** A crashed replay worker must not strand its claimed file for a minute. */
const processingOwnerIsDead = (name) => {
  const pid = Number(new RegExp(`^${OUTBOX_PREFIX.replaceAll('.', '\\.') }processing-(\\d+)-`).exec(name)?.[1])
  if (!Number.isSafeInteger(pid) || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

const hasReplayableOutbox = () => {
  try {
    return readdirSync(dirname(OUTBOX_PATH)).some((name) =>
      name === basename(OUTBOX_PATH) ||
      name.startsWith(`${OUTBOX_PREFIX}pending-`) ||
      (name.startsWith(`${OUTBOX_PREFIX}processing-`) && !name.endsWith('.tmp') && !name.endsWith('.ack')) ||
      name.startsWith(`${OUTBOX_PREFIX}ack-`),
    )
  } catch {
    return false
  }
}

/**
 * Send everything that was put aside, oldest first.
 *
 * Stops at the first transient failure and keeps the rest: the server is still
 * coming back, and draining into a restarting container would lose the queue
 * for the same reason it was written. A write the server actively rejects is
 * moved to a rejected sidecar with the response, never silently discarded.
 */
const flushOutbox = async () => {
  let sent = 0
  let rejected = 0
  const claimId = `${process.pid}-${randomUUID()}`
  let claimed = []
  try {
    claimed = await withOutboxLock(() => {
      const dir = dirname(OUTBOX_PATH)
      // Recover acknowledgements journaled before a crash between processing
      // file compaction and local ownership persistence.
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}ack-`) || !name.endsWith('.json')) continue
        const path = join(dir, name)
        try {
          const marker = JSON.parse(readFileSync(path, 'utf8'))
          if (updateRememberedOwnership(marker.path, marker.data)) rmSync(path, { force: true })
        } catch { /* retain the marker for the next recovery attempt */ }
      }
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}processing-`)) continue
        if (name.endsWith('.ack') || name.endsWith('.tmp')) continue
        const path = join(dir, name)
        try {
          if (
            processingOwnerIsDead(name) ||
            Date.now() - statSync(path).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)
          ) {
            renameSync(path, join(dir, `${OUTBOX_PREFIX}pending-${randomUUID()}`))
          }
        } catch { /* another recovery won the rename */ }
      }
      if (existsSync(OUTBOX_PATH) && statSync(OUTBOX_PATH).size > 0) {
        renameSync(OUTBOX_PATH, join(dir, `${OUTBOX_PREFIX}pending-${randomUUID()}`))
      }
      const paths = []
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}pending-`)) continue
        const from = join(dir, name)
        const to = join(dir, `${OUTBOX_PREFIX}processing-${claimId}-${randomUUID()}`)
        try {
          renameSync(from, to)
          paths.push(to)
        } catch { /* another replay process claimed it */ }
      }
      return paths
    })
  } catch {
    return { sent: 0, rejected: 0, left: existsSync(OUTBOX_PATH) ? 1 : 0 }
  }

  const reject = (entry) => {
    if (TEST_FAIL_REJECT_PERSIST) throw new Error('test failpoint: rejected-sidecar persistence failed')
    appendFileSync(REJECTED_OUTBOX_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    rejected += 1
  }

  for (const processingPath of claimed) {
    let lines
    try {
      lines = readFileSync(processingPath, 'utf8').split('\n').filter(Boolean)
    } catch {
      continue
    }
    let index = 0
    for (; index < lines.length; index += 1) {
    let item
    try {
      item = JSON.parse(lines[index])
    } catch {
      try {
        reject({ rejectedAt: new Date().toISOString(), reason: 'invalid JSON', raw: lines[index] })
      } catch {
        break
      }
      continue
    }
    if (!item.id || item.base !== BASE || item.agent !== AGENT || item.keyId !== KEY_ID) {
      try {
        reject({ rejectedAt: new Date().toISOString(), reason: 'replay context mismatch', item })
      } catch {
        break
      }
      continue
    }
    let res
    try {
      res = await fetch(`${BASE}${item.path}`, {
        method: item.method,
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': item.id,
          'X-Cairn-Queued-At': item.t,
        },
        body: item.body === undefined ? undefined : JSON.stringify(item.body),
      })
    } catch {
      break // still unreachable
    }
    if (TRANSIENT.has(res.status)) break
    let response = ''
    try {
      response = await res.text()
    } catch {
      response = '<response unavailable>'
    }
    let acknowledgedData = null
    if (res.ok) {
      sent += 1
      try {
        const payload = JSON.parse(response)
        if (payload?.success) acknowledgedData = payload.data
      } catch { /* a successful legacy endpoint may have no JSON body */ }
      if (TEST_CRASH_AFTER_SEND) process.kill(process.pid, 'SIGKILL')
    } else {
      try {
        reject({ rejectedAt: new Date().toISOString(), status: res.status, response: response.slice(0, 2_000), item })
      } catch {
        break
      }
    }
    const remaining = lines.slice(index + 1)
    const temp = `${processingPath}.tmp`
    if (TEST_FAIL_PERSIST_AFTER_SEND) throw new Error('test failpoint: replay persistence failed')
    const isCheckpoint = item.path.split('?')[0].endsWith('/checkpoint')
    const ackPath = `${OUTBOX_PREFIX}ack-${randomUUID()}.json`
    if (acknowledgedData && isCheckpoint) {
      writeFileSync(join(dirname(OUTBOX_PATH), ackPath), `${JSON.stringify({ path: item.path, data: acknowledgedData })}\n`, { mode: 0o600 })
    }
    writeFileSync(temp, remaining.length ? `${remaining.join('\n')}\n` : '', { mode: 0o600 })
    renameSync(temp, processingPath)
    if (TEST_CRASH_AFTER_RENAME_BEFORE_STATE && acknowledgedData && isCheckpoint) process.kill(process.pid, 'SIGKILL')
    // Advance local checkpoint state only after the acknowledged record has
    // been durably removed from the processing file. Otherwise a local
    // persistence failure leaves a phantom sequence gap for the next queue.
    if (acknowledgedData && isCheckpoint && updateRememberedOwnership(item.path, acknowledgedData)) {
      rmSync(join(dirname(OUTBOX_PATH), ackPath), { force: true })
    }
  }

    const left = lines.slice(index)
    if (left.length > 0) {
      try {
        await withOutboxLock(() => appendFileSync(OUTBOX_PATH, `${left.join('\n')}\n`, { mode: 0o600 }))
      } catch {
        continue
      }
    }
    rmSync(processingPath, { force: true })
  }

  let left = 0
  try { left = readFileSync(OUTBOX_PATH, 'utf8').split('\n').filter(Boolean).length } catch { /* empty */ }
  for (const path of claimed) if (existsSync(path)) {
    try { left += readFileSync(path, 'utf8').split('\n').filter(Boolean).length } catch { /* retry later */ }
  }
  return { sent, rejected, left }
}

const request = async (method, path, body, { soft = false } = {}) => {
  if (!KEY) die('CAIRN_API_KEY is not set (env, or ~/.cairn/env).')
  const isCheckpoint = path.split('?')[0].endsWith('/checkpoint')
  // A fresh checkpoint must not jump ahead of older durable checkpoints. Drain
  // first so the remembered sequence advances before this request is formed.
  if (!FLUSHING && isCheckpoint && hasReplayableOutbox()) {
    FLUSHING = true
    try { await flushOutbox() } finally { FLUSHING = false }
  }
  const taskState = rememberedTaskState(path)
  if (taskState && body && typeof body === 'object') {
    body = { ...body, ownershipVersion: taskState.ownershipVersion }
    if (isCheckpoint) body.checkpointVersion = taskState.checkpointVersion
  }
  let res
  const startedAt = Date.now()
  const spent = () => Date.now() - startedAt

  // A write that cannot get through is put aside rather than waited on. Only
  // ones whose answer the caller does not need; everything else fails fast,
  // which is still far better than blocking for minutes.
  const giveUp = (why) => {
    if (method !== 'GET' && QUEUEABLE.test(path.split('?')[0])) {
      if (path.split('?')[0].endsWith('/checkpoint') && rememberedOwnership(path) === null) {
        die(`${why}; checkpoint cannot be queued without a known ownership generation`)
      }
      return enqueue(method, path, body, why)
    }
    die(`${why} (${Math.round(spent() / 1000)}s)`)
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      if (attempt >= RETRIES || spent() > DEADLINE_MS) {
        return giveUp(`cannot reach ${BASE}: ${error.message}`)
      }
      await sleep(500 * 2 ** attempt)
      continue
    }
    if (TRANSIENT.has(res.status)) {
      if (attempt >= RETRIES || spent() > DEADLINE_MS) {
        return giveUp(`${BASE} returned ${res.status} — it is probably restarting`)
      }
      await sleep(500 * 2 ** attempt)
      continue
    }
    break
  }

  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (soft) return null
    die(`non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  if (!payload.success) {
    // `soft` callers are probing, not asserting. `cairn know <word>` tries the
    // word as a slug first and falls back to searching, and dying on the miss
    // made the fallback unreachable.
    if (soft) return null
    // Surface the server's guidance verbatim — it names valid enum values and,
    // on a refused close, suggests a resolution. Swallowing that would turn a
    // useful round-trip into a wasted one.
    const extra = payload.suggestedResolution
      ? `\nsuggested: ${payload.suggestedResolution}`
      : payload.issues
        ? `\n${payload.issues
            .map((i) => `  ${(i.path ?? []).join('.') || '(body)'}: ${i.message}`)
            .join('\n')}`
        : ''
    // 409 gets its own exit code so a caller can branch on "someone else has it".
    die(`${payload.error}${extra}`, payload.code === 'already_claimed' ? 9 : 1)
  }

  // Recorded here rather than at each call site: one place that already knows
  // the method, the path and that the server said yes.
  if (method !== 'GET') {
    rememberWrite(method, path, payload.data)
    updateRememberedOwnership(path, payload.data)
    // The server just answered, so anything put aside while it was down can go
    // now. No cron and nothing to remember to run: the next write drains it.
    if (!FLUSHING && hasReplayableOutbox()) {
      FLUSHING = true
      try {
        const { sent } = await flushOutbox()
        if (sent > 0) process.stderr.write(`replayed ${sent} queued write(s)\n`)
      } finally {
        FLUSHING = false
      }
    }
  }
  return payload.data
}

/**
 * The server validates against a MIME allowlist, and a Blob with no `type`
 * arrives as application/octet-stream — so every legitimate upload would be
 * rejected. Node has no mime lookup built in, so infer from the extension.
 */
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip', tar: 'application/x-tar',
  gz: 'application/gzip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

const mimeOf = (filePath) => {
  const ext = filePath.toLowerCase().split('.').pop()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const upload = async (path, filePath) => {
  if (!KEY) die('CAIRN_API_KEY is not set (env, or ~/.cairn/env).')
  if (!existsSync(filePath)) die(`no such file: ${filePath}`)

  const form = new FormData()
  // Let fetch set the multipart boundary; do not send a Content-Type header.
  form.append('file', new Blob([readFileSync(filePath)], { type: mimeOf(filePath) }), basename(filePath))

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  }).catch((error) => die(`cannot reach ${BASE}: ${error.message}`))

  const payload = await res.json().catch(() => null)
  if (!payload?.success) {
    die(payload?.error ?? `upload failed with ${res.status}`)
  }
  return payload.data
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const flatten = (value, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(value ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || v === undefined || v === '') continue // omit nulls entirely
    if (Array.isArray(v)) {
      if (!v.length) continue
      // An array of objects joined with a comma is a row of "[object Object]".
      // Index them instead, so `findings.0.note` is readable and greppable.
      if (v.some((item) => item && typeof item === 'object')) {
        v.forEach((item, i) => flatten(item, `${key}.${i}`, out))
      } else {
        out[key] = v.join(',')
      }
    } else if (typeof v === 'object') flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

const emit = (data, opts = {}) => {
  if (FORMAT === 'json') return console.log(JSON.stringify(data, null, 2))
  if (FORMAT === 'pretty') return console.log(JSON.stringify(data, null, 2))

  // Some answers are sentences, not a table. Forcing them through the
  // key/value flattener turns a finding worth reading into nine numbered rows
  // nobody reads.
  if (opts.lines) {
    for (const line of opts.lines(data)) console.log(line)
    return
  }

  const rows = opts.rows ? opts.rows(data) : Array.isArray(data) ? data : null
  if (!rows) {
    const flat = flatten(data)
    for (const [k, v] of Object.entries(flat)) console.log(`${k}\t${v}`)
    return
  }

  console.log(`#${rows.length}`) // count first: paginate before parsing
  if (rows.length === 0) return
  const flatRows = rows.map((r) => flatten(r))
  const cols = opts.columns ?? [...new Set(flatRows.flatMap((r) => Object.keys(r)))]
  console.log(cols.join('\t'))
  for (const r of flatRows) console.log(cols.map((c) => r[c] ?? '').join('\t'))
}

/** Comma or repeated-flag list, e.g. --label a,b --label c. */
/**
 * Which Cairn project a directory belongs to.
 *
 * The server can guess from sessions already recorded against a cwd, but only
 * after the first one. This is the explicit answer, kept next to the
 * credentials: a longest-prefix map in ~/.cairn/projects.json, so a monorepo
 * subdirectory can override its parent.
 */
const PROJECT_MAP_PATH = join(homedir(), '.cairn', 'projects.json')
const OWNERSHIP_DIR = join(homedir(), '.cairn', 'ownership')

const ownershipPath = (ref) => join(OWNERSHIP_DIR, `${ref.toUpperCase().replace(/[^A-Z0-9-]/g, '_')}.json`)

const rememberedTaskState = (path) => {
  const raw = /\/api\/v1\/tasks\/([^/?]+)\/(?:beat|checkpoint|release)$/.exec(path)?.[1]
  if (!raw) return null
  try {
    const value = JSON.parse(readFileSync(ownershipPath(decodeURIComponent(raw)), 'utf8'))
    if (!Number.isSafeInteger(value?.ownershipVersion)) return null
    return {
      ownershipVersion: value.ownershipVersion,
      checkpointVersion: Number.isSafeInteger(value?.checkpointVersion) ? value.checkpointVersion : 0,
    }
  } catch {
    return null
  }
}

const rememberedOwnership = (path) => rememberedTaskState(path)?.ownershipVersion ?? null

/** Count earlier durable checkpoints so each queued write reserves one sequence. */
const pendingCheckpointCount = (path, ownershipVersion) => {
  const endpoint = path.split('?')[0]
  let count = 0
  try {
    const dir = dirname(OUTBOX_PATH)
    const names = readdirSync(dir).filter((name) =>
      name === basename(OUTBOX_PATH) ||
      name.startsWith(`${OUTBOX_PREFIX}pending-`) ||
      (name.startsWith(`${OUTBOX_PREFIX}processing-`) && !name.endsWith('.tmp')),
    )
    for (const name of names) {
      let lines = []
      try { lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const line of lines) {
        try {
          const item = JSON.parse(line)
          if (
            item.path?.split('?')[0] === endpoint &&
            item.body?.ownershipVersion === ownershipVersion
          ) count += 1
        } catch { /* malformed records are quarantined by replay */ }
      }
    }
  } catch { /* no outbox yet */ }
  return count
}

const updateRememberedOwnership = (path, data) => {
  const match = /\/api\/v1\/tasks\/([^/?]+)\/(claim|checkpoint|release)$/.exec(path)
  if (!match) return false
  const target = ownershipPath(decodeURIComponent(match[1]))
  try {
    mkdirSync(OWNERSHIP_DIR, { recursive: true })
    if (match[2] === 'release') { rmSync(target, { force: true }); return true }
    const version = Number(data?.ownership_version)
    const checkpointVersion = Number(data?.checkpoint_version)
    if (!Number.isSafeInteger(version)) return false
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({
      ownershipVersion: version,
      checkpointVersion: Number.isSafeInteger(checkpointVersion) ? checkpointVersion : 0,
      agent: AGENT,
    })}\n`, { mode: 0o600 })
    renameSync(temp, target)
    return true
  } catch {
    // The server remains authoritative. Missing local context makes an offline
    // checkpoint fail closed instead of guessing an ownership generation.
    return false
  }
}

/**
 * A breadcrumb per successful write, so a session does not have to be guessed at.
 *
 * The session-end hook used to recover task refs with a regex over the
 * transcript, preferring refs on a line that also contained a `cairn` command.
 * A good heuristic, and still a guess: a dry run returned CAI-42 and
 * BBTRADE-1164 — refs out of documentation examples — instead of the tasks the
 * session actually worked. Those links feed search, and a session linked to
 * everything answers yes to everything, which is the same as knowing nothing.
 *
 * This end knows exactly what it acted on and whether the server accepted it.
 * Keyed on time rather than a session id on purpose: Codex and OpenClaw name
 * sessions in ways this process cannot see, but every runtime agrees on a
 * clock, and the hook already reads the transcript's first and last timestamps.
 */
const ACTED_PATH = join(homedir(), '.cairn', 'acted.jsonl')
const ACTED_MAX_BYTES = 256 * 1024
const ACTED_KEEP_LINES = 2000

/** Which ref a write acted on, from the server's answer or failing that the path. */
const refOfWrite = (path, data) => {
  const fromBody = typeof data?.ref === 'string' ? data.ref : null
  if (fromBody && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(fromBody)) return fromBody
  const fromPath = /\/api\/v1\/tasks\/([^/?]+)/.exec(path)?.[1]
  if (!fromPath) return null
  const decoded = decodeURIComponent(fromPath).toUpperCase()
  return /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(decoded) ? decoded : null
}

/** `claim`, `note`, `done` — the sub-resource, or the method when there is none. */
const verbOfWrite = (method, path) => {
  const tail = /\/api\/v1\/tasks\/[^/?]+\/([a-z-]+)/.exec(path)?.[1]
  if (tail) return tail
  if (path.includes('/tasks') && method === 'POST') return 'add'
  return { POST: 'add', PATCH: 'update', DELETE: 'delete' }[method] ?? method.toLowerCase()
}

/**
 * Append-only and self-trimming. A file that grows forever on a machine an
 * agent writes to every few seconds is a slow leak, and one that is rewritten
 * on every call would lose a concurrent write from a sibling agent.
 */
const rememberWrite = (method, path, data) => {
  const ref = refOfWrite(path, data)
  if (!ref) return
  try {
    mkdirSync(dirname(ACTED_PATH), { recursive: true })
    if (existsSync(ACTED_PATH) && statSync(ACTED_PATH).size > ACTED_MAX_BYTES) {
      const kept = readFileSync(ACTED_PATH, 'utf8').trim().split('\n').slice(-ACTED_KEEP_LINES)
      writeFileSync(ACTED_PATH, `${kept.join('\n')}\n`)
    }
    appendFileSync(
      ACTED_PATH,
      `${JSON.stringify({
        t: new Date().toISOString(),
        ref,
        verb: verbOfWrite(method, path),
        cwd: process.cwd(),
        agent: AGENT,
      })}\n`,
    )
  } catch {
    // A breadcrumb is a convenience for the hook. Never fail a write over one.
  }
}

const readProjectMap = () => {
  try {
    return JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const projectForDir = (dir) => {
  const map = readProjectMap()
  let best = null
  for (const [path, key] of Object.entries(map)) {
    if ((dir === path || dir.startsWith(`${path}/`)) && (!best || path.length > best[0].length)) {
      best = [path, key]
    }
  }
  return best?.[1] ?? null
}

const git = (dir, args) => {
  try {
    return (
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

const gitRoot = (dir) => git(dir, ['rev-parse', '--show-toplevel'])

/**
 * The repository this directory belongs to, as the server will know it.
 *
 * `origin` because that is what a clone writes. Sent raw: reducing spellings
 * to one repository is the server's rule, so the CLI, the MCP facade and an
 * import cannot drift apart on it.
 */
const gitRemote = (dir) => git(dir, ['remote', 'get-url', 'origin'])

/**
 * Deliberately not read on the resolution path: `rev-list --max-parents=0`
 * walks the whole history, which is milliseconds here and seconds on a large
 * repository, and the briefing hook can afford neither.
 */
const gitRootCommit = (dir) => git(dir, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').pop()

const splitList = (v) => {
  if (v === undefined || v === true) return []
  const parts = Array.isArray(v) ? v : [v]
  return parts.flatMap((p) => String(p).split(',')).map((x) => x.trim()).filter(Boolean)
}

/**
 * The briefing, as text a model reads once at the top of a session.
 *
 * Ordered by what changes behaviour soonest: what you are still holding, then
 * what is moving around you, then where the last session stopped, then what is
 * known here. Anything with nothing to say prints nothing at all -- an empty
 * heading is noise that trains the reader to skip the block.
 */
const renderContext = (d, { fileOnly = false } = {}) => {
  const out = []

  // A file read is a narrow question. Answering it with the whole project
  // briefing, on every Read, is how an injection channel becomes noise the
  // reader learns to skip -- and then the one time it matters, it is skipped.
  if (fileOnly) {
    const f = d.file
    if (!f || (!f.tasks.length && !f.knowledge.length)) return ''
    out.push(`## Cairn knows about ${f.path}`)
    for (const t of f.tasks) {
      out.push(`  ${t.ref}  ${t.status}${t.resolved ? ' (answered)' : ''}  ${truncate(t.title, 54)}`)
    }
    for (const k of f.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 54)}`)
    for (const sn of f.sessions.slice(0, 1)) {
      if (sn.nextSteps) out.push(`  last session here: ${truncate(sn.nextSteps, 160)}`)
    }
    return `${out.join('\n')}\n`
  }

  const where = d.project ? `[${d.project}]` : '[unfiled]'
  out.push(`## Cairn ${where}`)

  if (d.held?.length) {
    out.push('', 'You are holding:')
    for (const t of d.held) {
      const quiet = t.quiet ? '  <- no note in 24h; checkpoint or release it' : ''
      out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 58)}${quiet}`)
    }
  }

  if (d.inFlight?.length) {
    // Separated on purpose. "In flight" reads as work someone is on, and a
    // dropped task sitting in that list looked exactly like a live one --
    // which is how ten of them accumulated without anyone noticing.
    const live = d.inFlight.filter((t) => !t.stalled)
    const stalled = d.inFlight.filter((t) => t.stalled)

    if (live.length) {
      out.push('', 'In flight here:')
      for (const t of live) {
        const who = t.claimedBy ? `  (${t.claimedBy})` : ''
        out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 52)}${who}`)
      }
    }

    if (stalled.length) {
      out.push('', 'Started and dropped here -- nobody is on these:')
      for (const t of stalled) {
        out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 44)}  quiet ${t.quietFor}`)
      }
      out.push('  Finish one and close it with a resolution, or move it back to todo.')
    }
  }

  if (d.lastSession?.nextSteps) {
    out.push('', `Last session here left off (${d.lastSession.agent ?? 'unknown'}):`)
    out.push(`  ${truncate(d.lastSession.nextSteps, 400)}`)
  }

  if (d.knowledge?.length) {
    out.push('', 'Known here (cairn know <slug>):')
    for (const k of d.knowledge) {
      out.push(`  ${k.slug}${k.stale ? '  [stale]' : ''}  -- ${truncate(k.title, 58)}`)
    }
  }

  if (d.staleClaims?.length) {
    out.push('', 'Stale claims (lease expired, takeable):')
    for (const t of d.staleClaims) out.push(`  ${t.ref}  held ${t.heldFor} by ${t.claimedBy}`)
  }

  if (d.file) {
    const f = d.file
    if (f.tasks.length || f.knowledge.length) {
      out.push('', `About ${f.path}:`)
      for (const t of f.tasks) out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 56)}`)
      for (const k of f.knowledge) out.push(`  ${k.slug}  -- ${truncate(k.title, 56)}`)
    }
  }

  if (out.length === 1) return ''
  out.push('', 'Start with: cairn check "<subject>"')
  return `${out.join('\n')}\n`
}

const truncate = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const HELP = `cairn — agent-first task tracker and shared memory

  ALWAYS START HERE
    cairn check "<subject>"        what has already been done or debugged
                                   searches tasks, work-log notes, knowledge and
                                   sessions; --kinds task,note,knowledge,session

  read
    cairn next [--project K]       what to pick up, and why — ranked, never blocked
    cairn list [--project K] [--status S] [--type T] [--label L] [--mine]
    cairn show <ref>               e.g. CAI-42
    cairn log <ref> [--kind K]     the work log
    cairn projects

  write
    cairn add "<title>" --project K [--type bug] [--priority high] [--body -]
    cairn add ... --start          file it and claim it, when you are starting now
    cairn update <ref> [--title T] [--status S] [--type T] [--priority P]
    cairn update <ref> --also-project HM,AT      work that spans several projects
    cairn update <ref> --project OTHER      moves it; the ref changes
    cairn note <ref> "<text>" [--kind note|finding|decision|attempt|handoff]
    cairn commit <ref> <sha> [--repo PATH] [--branch NAME] [--message TEXT] [--url URL]
    cairn push <ref> <sha> [--repo PATH] [--branch NAME] [--remote NAME] [--url URL]
    cairn run <ref> "<command>" --status passed|failed|skipped [--exit-code N]
                                   these three RECORD what you already did;
                                   none of them runs anything. Recording the
                                   same commit twice is one line, not two.
    cairn comment <ref> "<text>"
    cairn done <ref> --resolution "<what was actually done>" [--kind fixed]
    cairn cancel <ref> --resolution "<why it is being dropped>" [--kind wont-fix]
    cairn done <ref> --duplicate-of CAI-31 --resolution "…"   points at the original
    cairn attach <ref> <file>      |   cairn files <ref>

  sub-tasks
    cairn add "<title>" --project K --parent CAI-42   file it under an existing task
    cairn children <ref>                    the direct split
    cairn update <ref> --parent CAI-42 | --no-parent

  history
    cairn history <ref>                     what changed, when, and who changed it

  dependencies
    cairn deps <ref>                        what blocks this, and what it blocks
    cairn blockedby <ref> <other>           mark <ref> as blocked by <other>
    cairn unblockedby <ref> <other>         remove that link

  labels
    cairn labels                            every label in use, busiest first
    cairn labels rename <from> <to>         renaming onto an existing label merges them
    cairn labels remove <label>

  projects
    cairn map [<KEY>|none]                       which project this directory is
    cairn --version                              this CLI, the server, and whether they match
    cairn projects [--archived]                  --archived includes retired ones
    cairn project rename <KEY> "<title>"
    cairn project archive <KEY>                  hides it; the tasks stay searchable
    cairn project restore <KEY>
    cairn project delete <KEY> --confirm <KEY>   deletes every task in it
    cairn task delete <ref> --confirm <ref>       junk only; refuses a task with history

  memory
    cairn context                  the briefing: what you hold, what is in flight,
                                   where the last session here stopped, what is known
    cairn learn "<title>" --body - record what we now know
                                   --project K  true of that project
                                   --entity E   true of that grouping (cairn entities)
                                   --global     true everywhere — say so on purpose
                                   none of them: inferred from this directory's
                                   project, and it refuses if there is none
    cairn entities                 groupings a fact can be true of, and their projects
    cairn entities assign|unassign <key> --project A,B
    cairn entities rename <key> --key <new> --title "T"
    cairn know [<slug>|<query>]    read it back, or list what applies here
    cairn verify <slug>            it is still true — clears the stale mark
    cairn replay                   send writes put aside while the server was down
    cairn relearn <slug> --body -  correct it
    cairn unlearn <slug> [--superseded-by <slug>]
    cairn session list             recent sessions
    cairn session end --id <id>    write the episodic record, checkpoint what is held
    cairn reconcile                release your own claims that went quiet
    cairn vitals [--hours 24] [--all]   is the memory still being written
    cairn vitals --notify <ref>         post findings as a note, silent if none

  coordinate
    cairn claim <ref>              exits 9 if another agent holds it
    cairn beat <ref>               keep a claim alive
    cairn checkpoint <ref> --summary "<where things stand>"
    cairn release <ref>
    cairn block <ref> --reason "<why>"   |   cairn unblock <ref>

  output
    --json | --pretty              default is TSV: count line, header, rows
    --body -  /  --resolution -    read the value from stdin

  env: CAIRN_BASE_URL, CAIRN_API_KEY
`

const need = (v, msg) => (v === undefined || v === true ? die(msg) : v)

/** Shared by `done` and `cancel`: both close, and both must say how. */
const closeTask = async (status, defaultKind) => {
  const verb = status === 'done' ? 'done' : 'cancel'
  const ref = need(positional[0], `usage: cairn ${verb} <ref> --resolution "<why>"`)
  const resolution = await resolveValue(
    need(flags.resolution, 'a --resolution is required: say what was actually done, and why'),
  )
  const body = { status, resolution, resolutionKind: flags.kind ?? defaultKind }
  // Naming the original is what makes "duplicate" useful to whoever finds it.
  if (flags['duplicate-of']) {
    body.duplicateOf = flags['duplicate-of']
    body.resolutionKind = 'duplicate'
  }
  emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
}

/** `from -> to`, or the raw keys, kept to one short cell. */
const summariseEvent = (data) => {
  if (!data || typeof data !== 'object') return ''
  if ('from' in data || 'to' in data) {
    const from = Array.isArray(data.from) ? data.from.join('|') : (data.from ?? '')
    const to = Array.isArray(data.to) ? data.to.join('|') : (data.to ?? '')
    return `${from} -> ${to}`
  }
  return Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

const commands = {
  async check() {
    const q = need(positional[0], 'usage: cairn check "<subject>"')
    const params = new URLSearchParams({ q })
    if (flags.project) params.set('project', flags.project)
    if (flags.type) params.set('type', flags.type)
    if (flags.kinds) params.set('kinds', flags.kinds)
    if (flags.tasks) params.set('tasksOnly', '1')
    const data = await request('GET', `/api/v1/search?${params}`)
    emit(data, {
      rows: (d) =>
        d.results.map((r) => ({
          kind: r.kind ?? 'task',
          ref: r.ref,
          // A stale fact is still current knowledge; what it is not is
          // confirmed. Said in the column already read for exactly that,
          // rather than as a column everyone learns to ignore.
          status: r.stale ? 'stale' : (r.status ?? ''),
          type: r.type ?? '',
          answered: r.resolved ? 'yes' : '',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
      columns: ['kind', 'ref', 'status', 'type', 'answered', 'tokens', 'title'],
    })
    if (FORMAT !== 'tsv') return

    if (data.results.length === 0) {
      process.stderr.write('nothing found — this subject looks new\n')
      return
    }

    // Widening only happens when the precise query came back thin, so a result
    // set that is entirely loose means nothing actually matched the subject.
    // Without saying so, twenty plausible-looking rows read as prior work.
    const loose = data.results.filter((r) => r.loose).length
    if (loose === data.results.length) {
      process.stderr.write(
        `no precise match — all ${loose} rows are loose word overlaps, so treat this subject as new unless one genuinely fits\n`,
      )
    } else if (loose > 0) {
      process.stderr.write(`${data.results.length - loose} precise, ${loose} loose\n`)
    }
  },

  async list() {
    const project = need(flags.project ?? positional[0], 'usage: cairn list --project <KEY>')
    const params = new URLSearchParams()
    for (const k of ['status', 'type', 'label', 'limit', 'offset']) {
      if (flags[k]) params.set(k, flags[k])
    }
    if (flags.mine) params.set('claimed_by', process.env.CAIRN_AGENT ?? '')
    const data = await request('GET', `/api/v1/projects/${project}/tasks?${params}`)
    emit(data, {
      rows: (d) =>
        d.tasks.map((t) => ({
          ref: `${t.project?.key ?? project}-${t.number}`,
          status: t.status,
          type: t.type,
          priority: t.priority,
          held: t.claimed_by ?? '',
          answered: t.resolution ? 'yes' : '',
          title: truncate(t.title, 70),
        })),
      columns: ['ref', 'status', 'type', 'priority', 'held', 'answered', 'title'],
    })
  },

  async show() {
    const ref = need(positional[0], 'usage: cairn show <ref>')
    // A digest by default: the answer in full, findings and decisions, a
    // clipped body, and a note of what was withheld. `--full` for everything.
    const suffix = flags.full ? '' : '?view=digest'
    const data = await request('GET', `/api/v1/tasks/${ref}${suffix}`)
    emit(data)
    if (FORMAT === 'tsv' && data.omitted) {
      const { descriptionBytes, attemptsAndNotes, tokensToFetchFull } = data.omitted
      if (descriptionBytes || attemptsAndNotes) {
        process.stderr.write(
          `withheld: ${descriptionBytes}B of body, ${attemptsAndNotes} attempt/note(s)` +
            ` — cairn show ${ref} --full is ~${tokensToFetchFull} tokens\n`,
        )
      }
    }
  },

  async projects() {
    const suffix = flags.archived ? '?archived=1' : ''
    emit(await request('GET', `/api/v1/projects${suffix}`))
  },

  async add() {
    const title = need(positional[0], 'usage: cairn add "<title>" --project <KEY>')
    const project = need(flags.project, 'a --project is required')

    /**
     * A bug or a spike with no body is not yet a report — it is a title.
     *
     * Measured before this existed: 23% of tasks filed in a month had an empty
     * description, and it split by author rather than by subject — 51% for one
     * agent, 75% for another, 0% for tasks filed by a human through the UI. The
     * same agents write a resolution on every single close, because `done`
     * refuses without one. Guidance alone had not moved it; a refusal had.
     *
     * Only where the body carries the value. A chore is often fully described
     * by its title, and demanding prose there teaches people to type "n/a",
     * which is worse than an empty field because it looks answered.
     */
    // Resolved once, here: `--body -` reads stdin, which cannot be read twice,
    // and both the check below and the request itself need the value.
    const described = flags.body ? String(await resolveValue(flags.body)) : undefined

    const NEEDS_BODY = new Set(['bug', 'spike'])
    if (NEEDS_BODY.has(flags.type) && !flags['force-empty']) {
      if ((described ?? '').trim().length < 40) {
        die(
          `a ${flags.type} needs a body: what happens, what you expected, and how to see it.\n` +
            '  cairn add "<title>" --project K --type ' + flags.type + ' --body -   # markdown on stdin\n' +
            '  ...--body "one line is fine when that is genuinely all there is"\n' +
            'If the title really is the whole story, pass --force-empty.',
        )
      }
    }

    // Warn on a near-duplicate rather than silently filing one.
    //
    // websearch_to_tsquery ANDs its terms, so passing the whole title finds
    // nothing unless a prior task shares every word. For a similarity check we
    // want the opposite, so OR the distinctive words together instead.
    const terms = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
    const probe = terms.length ? terms.join(' OR ') : title
    // Tasks only. "Has this already been filed" is a question about tasks, and
    // answering it with a session from three weeks ago is noise in front of the
    // one thing the agent is about to decide.
    const dupes = await request(
      'GET',
      `/api/v1/search?${new URLSearchParams({ q: probe, kinds: 'task' })}`,
    )
    if (dupes.results.length > 0) {
      process.stderr.write('similar existing work:\n')
      for (const r of dupes.results.slice(0, 3)) {
        process.stderr.write(`  ${r.ref} [${r.status}] ${r.title}\n`)
      }
    }

    const body = { title }
    if (described !== undefined) body.description = described

    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    if (flags.parent) body.parentRef = flags.parent
    const created = await request('POST', `/api/v1/projects/${project}/tasks`, body)

    // File-and-work-it-now is the pattern that skips claiming: the agent that
    // files a task and finishes it in the same session never perceives a
    // difference, so the board shows backlog while the work happens.
    if (flags.start) {
      const held = await request('POST', `/api/v1/tasks/${created.ref}/claim`, {})
      return emit({ ...created, status: held.status, claimed_by: held.claimed_by })
    }
    emit(created)
  },

  async update() {
    const ref = need(positional[0], 'usage: cairn update <ref> --status <s>')
    const body = {}
    if (flags.title) body.title = flags.title
    if (flags.body) body.description = await resolveValue(flags.body)
    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    // Passed through so a single update can move to a closing status and say
    // how in one call — without it the API rightly refuses the move.
    if (flags.resolution) body.resolution = await resolveValue(flags.resolution)
    if (flags.kind) body.resolutionKind = flags.kind
    if (flags.parent) body.parentRef = flags.parent
    if (flags['no-parent']) body.parentRef = null
    // Moving renumbers the task, so the response reports the new ref.
    if (flags.project) body.project = flags.project
    // Widening does not: the task keeps its home project and its ref, and only
    // starts appearing in the other projects' lists and boards too.
    if (flags['also-project'] !== undefined) body.alsoProjects = splitList(flags['also-project'])
    if (flags['duplicate-of']) {
      body.duplicateOf = flags['duplicate-of']
      body.resolutionKind = 'duplicate'
    }
    emit(await request('PATCH', `/api/v1/tasks/${ref}`, body))
  },

  async done() {
    return closeTask('done', 'fixed')
  },

  /**
   * Cancelling is closing too. Without this the CLI could reach five of the
   * six statuses, and a task dropped on purpose had to be edited by hand.
   */
  async cancel() {
    return closeTask('cancelled', 'wont-fix')
  },

  async commit() {
    const ref = need(positional[0], 'usage: cairn commit <ref> <sha> [--repo PATH]')
    const sha = need(positional[1], 'a commit SHA is required')
    const payload = { event: 'git_commit', sha }
    if (flags.repo) payload.repo = flags.repo
    if (flags.branch) payload.branch = flags.branch
    if (flags.message) payload.message = await resolveValue(flags.message)
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async push() {
    const ref = need(positional[0], 'usage: cairn push <ref> <sha> [--repo PATH]')
    const sha = need(positional[1], 'the pushed commit SHA is required')
    const payload = { event: 'git_push', sha }
    if (flags.repo) payload.repo = flags.repo
    if (flags.branch) payload.branch = flags.branch
    if (flags.remote) payload.remote = flags.remote
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async run() {
    const ref = need(positional[0], 'usage: cairn run <ref> "<command>" --status passed|failed|skipped')
    const command = await resolveValue(need(positional[1], 'the command is required'))
    const status = need(flags.status, '--status is required')
    if (!['passed', 'failed', 'skipped'].includes(status)) {
      die('--status must be passed, failed, or skipped')
    }
    const payload = { event: 'run_result', command, status }
    for (const [flag, field] of [['exit-code', 'exitCode'], ['duration-ms', 'durationMs']]) {
      if (flags[flag] !== undefined) payload[field] = Number(flags[flag])
    }
    if (flags.output !== undefined) payload.output = await resolveValue(flags.output)
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async note() {
    const ref = need(positional[0], 'usage: cairn note <ref> "<text>"')
    const note = await resolveValue(need(positional[1], 'a note body is required'))
    const result = await request('POST', `/api/v1/tasks/${ref}/notes`, {
      note,
      kind: flags.kind ?? 'note',
    })
    emit(result)

    // Said, not inferred. Writing a note used to claim the task, which put
    // work in `doing` that nobody was doing — annotating is most of what
    // reading a backlog is. Pointing at the claim leaves the judgement with
    // the only party that knows which of the two this was.
    if (result?.unclaimed && FORMAT === 'tsv') {
      process.stderr.write(
        `${ref} is open and unclaimed — \`cairn claim ${ref}\` if you are working it\n`,
      )
    }
  },

  async log() {
    const ref = need(positional[0], 'usage: cairn log <ref>')
    const suffix = flags.kind ? `?kind=${flags.kind}` : ''
    const data = await request('GET', `/api/v1/tasks/${ref}/notes${suffix}`)
    emit(data, {
      rows: (d) =>
        d.map((n) => ({
          kind: n.kind,
          by: n.actor_id,
          at: n.created_at.slice(0, 16).replace('T', ' '),
          note: truncate(n.note, 90),
        })),
      columns: ['kind', 'by', 'at', 'note'],
    })
  },

  async comment() {
    const ref = need(positional[0], 'usage: cairn comment <ref> "<text>"')
    const content = await resolveValue(need(positional[1], 'a comment body is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/comments`, { content }))
  },

  async attach() {
    const ref = need(positional[0], 'usage: cairn attach <ref> <file>')
    const file = need(positional[1], 'a file path is required')
    const size = statSync(file).size
    process.stderr.write(`uploading ${basename(file)} (${size} bytes, ${mimeOf(file)})\n`)
    emit(await upload(`/api/v1/tasks/${ref}/attachments`, file))
  },

  async files() {
    const ref = need(positional[0], 'usage: cairn files <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/attachments`)
    emit(data, {
      rows: (d) =>
        d.map((a) => ({
          id: a.id,
          name: a.original_name,
          type: a.mime_type,
          bytes: a.size_bytes,
          by: a.actor_id,
        })),
      columns: ['id', 'name', 'type', 'bytes', 'by'],
    })
  },

  async children() {
    const ref = need(positional[0], 'usage: cairn children <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/children`)
    emit(data.children, {
      rows: (d) => d.map((t) => ({ ref: t.ref, status: t.status, title: truncate(t.title, 62) })),
      columns: ['ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv') {
      process.stderr.write(
        data.count === 0 ? 'no sub-tasks\n' : `${data.closed}/${data.count} closed\n`,
      )
    }
  },

  async history() {
    const ref = need(positional[0], 'usage: cairn history <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/activity`)
    emit(data, {
      rows: (d) =>
        d.map((e) => ({
          when: e.created_at.slice(0, 16).replace('T', ' '),
          who: e.actor_id,
          event: e.event,
          detail: summariseEvent(e.data),
        })),
      columns: ['when', 'who', 'event', 'detail'],
    })
    if (FORMAT === 'tsv' && data.length === 0) process.stderr.write('no recorded activity\n')
  },

  async deps() {
    const ref = need(positional[0], 'usage: cairn deps <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/dependencies`)
    emit(data, {
      rows: (d) =>
        d.map((r) => ({
          direction: r.direction,
          ref: r.ref,
          status: r.status,
          title: truncate(r.title, 62),
        })),
      columns: ['direction', 'ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv' && data.length === 0) {
      process.stderr.write('no dependencies\n')
    }
  },

  async blockedby() {
    const ref = need(positional[0], 'usage: cairn blockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    emit(await request('POST', `/api/v1/tasks/${ref}/dependencies`, {
      ref: other,
      direction: 'blocked-by',
    }))
  },

  async unblockedby() {
    const ref = need(positional[0], 'usage: cairn unblockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    const q = new URLSearchParams({ ref: other, direction: 'blocked-by' })
    emit(await request('DELETE', `/api/v1/tasks/${ref}/dependencies?${q}`))
  },

  async labels() {
    const sub = positional[0]
    if (sub === 'rename' || sub === 'merge') {
      const from = need(positional[1], 'usage: cairn labels rename <from> <to>')
      const to = need(positional[2], 'a new label name is required')
      emit(await request('PATCH', '/api/v1/labels', { from, to }))
      return
    }
    if (sub === 'remove' || sub === 'delete') {
      const from = need(positional[1], 'usage: cairn labels remove <label>')
      emit(await request('PATCH', '/api/v1/labels', { from, to: null }))
      return
    }
    if (sub) die(`unknown subcommand "${sub}" — expected rename or remove`)

    const data = await request('GET', '/api/v1/labels')
    emit(data, {
      rows: (d) => d.map((l) => ({ label: l.label, tasks: l.task_count })),
      columns: ['label', 'tasks'],
    })
  },

  /**
   * Deleting a task, which almost nobody should be doing.
   *
   * `cancel` keeps the record and the reason and is what this store is for;
   * this is for junk that should never have existed. The server refuses a task
   * with children, notes, comments or dependants, and demands the ref back.
   */
  async task() {
    const sub = need(positional[0], 'usage: cairn task delete <ref> --confirm <ref>')
    if (sub !== 'delete') die(`unknown subcommand "${sub}" — expected delete`)
    const ref = need(positional[1], 'a task ref is required, e.g. CAI-42')

    // Ask before telling: the ref the server knows is canonical (a former
    // project key still resolves), and confirming with a spelling the server
    // will not echo back would fail for a reason nobody could see.
    const task = await request('GET', `/api/v1/tasks/${encodeURIComponent(ref)}`)
    const canonical = `${task.project.key}-${task.number}`

    if (flags.confirm !== canonical) {
      die(
        `This permanently deletes ${canonical} — "${task.title}" — and cannot be undone.\n` +
          `Cancelling keeps the record: cairn cancel ${canonical} --resolution "..."\n` +
          `Re-run with --confirm ${canonical} if deletion is really what you want.`,
      )
    }

    emit(
      await request(
        'DELETE',
        `/api/v1/tasks/${encodeURIComponent(canonical)}?confirm=${encodeURIComponent(canonical)}`,
      ),
    )
  },

  async project() {
    const sub = need(positional[0], 'usage: cairn project <rename|delete> <KEY> [...]')
    const key = need(positional[1], 'a project key is required')

    if (sub === 'rename') {
      const title = need(positional[2], 'usage: cairn project rename <KEY> "<new title>"')
      emit(await request('PATCH', `/api/v1/projects/${key}`, { title }))
      return
    }
    if (sub === 'archive' || sub === 'restore') {
      emit(await request('PATCH', `/api/v1/projects/${key}`, {
        status: sub === 'archive' ? 'archived' : 'active',
      }))
      return
    }
    if (sub === 'delete') {
      // Deleting a project removes every task in it. The API demands the key
      // back as confirmation; require it here too rather than passing it
      // silently on the caller's behalf.
      if (flags.confirm !== key) {
        const info = await request('GET', `/api/v1/projects/${key}`)
        die(
          `This would delete ${info.task_count} task(s) in ${key} and everything ` +
            `attached to them, permanently.\nRe-run with --confirm ${key} if that is what you want.`,
        )
      }
      emit(await request('DELETE', `/api/v1/projects/${key}?confirm=${encodeURIComponent(key)}`))
      return
    }
    die(`unknown subcommand "${sub}" — expected rename, archive, restore or delete`)
  },

  async claim() {
    const ref = need(positional[0], 'usage: cairn claim <ref>')
    emit(await request('POST', `/api/v1/tasks/${ref}/claim`, {}))
  },
  async beat() {
    emit(await request('POST', `/api/v1/tasks/${need(positional[0], 'usage: cairn beat <ref>')}/beat`, {}))
  },
  async release() {
    emit(await request('POST', `/api/v1/tasks/${need(positional[0], 'usage: cairn release <ref>')}/release`, {}))
  },
  async checkpoint() {
    const ref = need(positional[0], 'usage: cairn checkpoint <ref> --summary "<state>"')
    const summary = await resolveValue(need(flags.summary, 'a --summary is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/checkpoint`, { summary }))
  },
  async block() {
    const ref = need(positional[0], 'usage: cairn block <ref> --reason "<why>"')
    const reason = await resolveValue(need(flags.reason, 'a --reason is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/block`, { reason }))
  },
  async unblock() {
    const ref = need(positional[0], 'usage: cairn unblock <ref>')
    emit(await request('POST', `/api/v1/tasks/${ref}/block`, { reason: null }))
  },

  // --- knowledge ---------------------------------------------------------

  async learn() {
    const title = need(positional[0], 'usage: cairn learn "<title>" --body -')
    const body = await resolveValue(flags.body ?? '')
    /**
     * Scope is decided before the write, not regretted after it.
     *
     * This used to default to global whenever --project was absent, and warn
     * afterwards. Measured over the store, the import scoped 8% of its facts
     * global while everything written here since ran at 27% — three times
     * worse, which is what a silent default to the widest scope predicts. A
     * misfiled task is a nuisance in one place; a fact filed global is in
     * front of every project, permanently.
     *
     * So: an explicit scope wins, a mapped directory supplies one when none
     * is given, and global has to be asked for. `cairn add` has always
     * refused to file a task without a project; this is the same rule for the
     * half that travels further.
     */
    const chosen = splitList(flags.project)
    const entities = flags.entity ? splitList(flags.entity) : []

    // Only when nothing was chosen, so the common path costs nothing extra.
    // The local map answers most of the time; the git remote answers where it
    // cannot — a second clone, a worktree, a directory nobody ran `cairn map`
    // in — and only the server can turn a remote into a project, so it is
    // asked. This is the same resolution `cairn context` performs, and the
    // same principle as resolving a task's project from the repository rather
    // than the path (CAIRN-123).
    let here = null
    if (!chosen.length && !entities.length && !flags.global) {
      const cwd = process.cwd()
      here = projectForDir(cwd)
      if (!here) {
        const remote = gitRemote(cwd)
        if (remote) {
          const params = new URLSearchParams({ cwd, repo: remote })
          const seen = await request('GET', `/api/v1/context?${params}`, undefined, { soft: true })
          here = seen?.project ?? null
        }
      }
    }

    if (!chosen.length && !entities.length && !flags.global && !here) {
      die(
        'scope this fact before filing it:\n' +
          '  --project <KEY>   true of one codebase\n' +
          '  --entity <key>    true of a business or a stack (cairn entities)\n' +
          '  --global          true everywhere — say so on purpose\n' +
          'This directory maps to no project, so there is nothing to infer from.',
      )
    }

    const projects = chosen.length ? chosen : here ? [here] : []

    const payload = {
      title,
      body,
      labels: splitList(flags.label),
      projects,
    }
    if (entities.length) payload.entities = entities
    if (flags.slug) payload.slug = flags.slug
    if (flags.task) payload.sourceTaskRef = flags.task
    if (flags.verified) payload.verified = true

    const result = await request('POST', '/api/v1/knowledge', payload)
    emit(result)

    // Say what was inferred. Silent correctness is still a surprise the next
    // time someone expects the old behaviour.
    if (FORMAT === 'tsv' && here) {
      process.stderr.write(`scoped to ${here} — this directory's project. --global if it is true everywhere\n`)
    }
  },

  async know() {
    const subject = positional[0]

    // A bare word that is a slug we hold is a fetch; anything else is a search.
    // Agents should not have to know which, and the distinction is cheap to make.
    //
    // Underscores are accepted because the store is full of `[[a_b_c]]`
    // references that mean `a-b-c` — they arrived with the claude-mem import.
    // While this shape rejected them, following one's own reference fell
    // through to full-text search, which on a real pair returned five loosely
    // related entries and not the target, with nothing to say it had missed.
    // The server normalises the spelling on lookup; this only has to stop
    // ruling the reference out before asking.
    if (subject && /^[a-z0-9]+([_-][a-z0-9]+)*$/i.test(subject)) {
      const hit = await request('GET', `/api/v1/knowledge/${subject}`, undefined, { soft: true })
      if (hit) {
        if (FORMAT === 'json') return emit(hit)
        const k = hit
        process.stdout.write(`# ${k.title}\n`)
        if (k.labels?.length) process.stdout.write(`labels: ${k.labels.join(', ')}\n`)
        // Both scopes, or this reports a fact scoped to an entity as true
        // everywhere — which is the opposite of what it says.
        const scope = k.projects?.length
          ? k.projects.join(', ')
          : k.entities?.length
            ? k.entities.join(', ')
            : 'global'
        process.stdout.write(`scope: ${scope}\n\n`)
        process.stdout.write(`${k.body}\n`)
        return
      }
    }

    const params = new URLSearchParams()
    // Set before the search branch returns, not after it. Living below that
    // early return, --project was accepted and silently dropped on every
    // `cairn know "<query>" --project K` — the CAIRN-145 failure exactly,
    // relocated from the SQL into the CLI, on the verb agents use most. The
    // server honours the parameter; only this dropped it.
    if (flags.project) params.set('project', flags.project)
    if (flags.label) params.set('label', flags.label)
    if (flags.limit) params.set('limit', flags.limit)
    if (flags.superseded) params.set('superseded', '1')

    if (subject) {
      params.set('q', subject)
      params.set('kinds', 'knowledge')
      const data = await request('GET', `/api/v1/search?${params}`)
      return emit(data, {
        rows: (d) => d.results.map((r) => ({
          slug: r.ref,
          scope: r.project ?? 'global',
          tokens: `~${r.tokens}`,
          title: truncate(r.title, 70),
        })),
        columns: ['slug', 'scope', 'tokens', 'title'],
      })
    }

    const data = await request('GET', `/api/v1/knowledge?${params}`)
    emit(data, {
      rows: (d) => d.results.map((r) => ({
        slug: r.slug,
        // Where it applies, narrowest first: this project, else the groupings
        // it belongs to, else everywhere.
        scope: r.projects?.length
          ? r.projects.join(',')
          : r.entities?.length
            ? r.entities.join(',')
            : 'global',
        verified: r.verified ? 'yes' : '',
        tokens: `~${r.tokens}`,
        title: truncate(r.title, 70),
      })),
      columns: ['slug', 'scope', 'verified', 'tokens', 'title'],
    })
  },

  async unlearn() {
    const slug = need(positional[0], 'usage: cairn unlearn <slug> [--superseded-by <slug>]')
    if (flags['superseded-by']) {
      return emit(await request('PATCH', `/api/v1/knowledge/${slug}`, {
        supersededBy: flags['superseded-by'],
      }))
    }
    emit(await request('DELETE', `/api/v1/knowledge/${slug}`))
  },

  /**
   * Confirm a fact is still true, without rewriting it.
   *
   * The correction path already existed (`relearn`); the confirmation path did
   * not, so the only way to clear a stale mark was to restate the whole body.
   * Marking something stale and offering no cheap way to answer is how a
   * confidence signal becomes noise everyone learns to scroll past.
   */
  async verify() {
    const slug = need(positional[0], 'usage: cairn verify <slug>')
    emit(await request('PATCH', `/api/v1/knowledge/${slug}`, { verified: true }))
  },

  /**
   * Send whatever was put aside while the server was unreachable.
   *
   * Rarely needed by hand — any successful write drains the queue — but a
   * queue with no way to look at it is a queue nobody trusts.
   */
  async replay() {
    const result = await flushOutbox()
    emit(result, {
      lines: (d) =>
        d.sent + d.rejected + d.left === 0
          ? ['nothing queued']
          : [`sent ${d.sent}, rejected ${d.rejected}, still queued ${d.left}`],
    })
  },

  async relearn() {
    const slug = need(positional[0], 'usage: cairn relearn <slug> [--body -] [--title T]')
    const patch = {}
    if (flags.body !== undefined) patch.body = await resolveValue(flags.body)
    if (flags.title) patch.title = flags.title
    if (flags.label) patch.labels = splitList(flags.label)
    if (flags.project) patch.projects = splitList(flags.project)
    if (flags.entity !== undefined) patch.entities = splitList(flags.entity)
    if (flags.verified) patch.verified = true
    emit(await request('PATCH', `/api/v1/knowledge/${slug}`, patch))
  },

  async entities() {
    const verb = positional.shift()

    if (verb === 'add') {
      const key = need(positional[0], 'usage: cairn entities add <key> "<title>" [--project A,B]')
      return emit(
        await request('POST', '/api/v1/entities', {
          key,
          title: positional[1] ?? key,
          description: flags.description ?? '',
          projects: splitList(flags.project),
        }),
      )
    }

    if (verb === 'rename') {
      const key = need(positional[0], 'usage: cairn entities rename <key> [--key <new>] [--title "T"]')
      const patch = { key }
      if (flags.key) patch.newKey = flags.key
      if (flags.title) patch.title = flags.title
      if (flags.description) patch.description = flags.description
      return emit(await request('PATCH', '/api/v1/entities', patch))
    }

    if (verb === 'assign' || verb === 'unassign') {
      const key = need(positional[0], `usage: cairn entities ${verb} <key> --project A,B`)
      const projects = splitList(flags.project ?? positional[1])
      if (projects.length === 0) die('--project is required')
      return emit(
        await request('PATCH', '/api/v1/entities', {
          key,
          addProjects: verb === 'assign' ? projects : [],
          removeProjects: verb === 'unassign' ? projects : [],
        }),
      )
    }

    if (verb) die(`unknown entities verb "${verb}" — try: add, rename, assign, unassign`)

    const data = await request('GET', '/api/v1/entities')
    emit(data, {
      rows: (d) =>
        d.results.map((e) => ({
          entity: e.key,
          projects: e.projects.length,
          keys: truncate(e.projects.join(' '), 58),
          title: e.title,
        })),
      columns: ['entity', 'projects', 'keys', 'title'],
    })
  },

  /**
   * What to pick up, rather than what exists.
   *
   * The briefing says what is held, in flight and dropped, and never which one
   * to do — so every agent invented its own ranking and they disagreed. The
   * reason is printed with the pick because a recommendation nobody can check
   * is one nobody should follow.
   */
  async next() {
    const params = new URLSearchParams()
    const project = flags.project ?? projectForDir(process.cwd())
    if (project) params.set('project', project)
    const data = await request('GET', `/api/v1/next?${params}`)

    if (FORMAT === 'json') return emit(data)
    if (!data.pick) {
      const why = data.considered
        ? `nothing workable — ${data.considered} open, all blocked, waiting on something, or held by someone else`
        : 'nothing open'
      process.stdout.write(`${why}\n`)
      return
    }

    const line = (t) => `${t.ref}  ${t.title}`
    process.stdout.write(
      `${line(data.pick)}\n  ${data.pick.reason}\n  ${data.pick.priority} · ${data.pick.status}` +
        `\n\n  cairn claim ${data.pick.ref}\n` +
        (data.then?.length
          ? `\nthen:\n${data.then.map((t) => `  ${line(t)}`).join('\n')}\n`
          : ''),
    )
  },

  // --- the briefing ------------------------------------------------------

  async context() {
    const cwd = flags.cwd ?? process.cwd()
    const params = new URLSearchParams()
    params.set('cwd', cwd)
    const project = flags.project ?? projectForDir(cwd)
    if (project) params.set('project', project)
    // Costs one local git call and answers where the map cannot: a second
    // clone, a moved directory, a worktree.
    const repo = gitRemote(cwd)
    if (repo) params.set('repo', repo)
    if (flags.file) params.set('file', flags.file)
    const data = await request('GET', `/api/v1/context?${params}`)
    if (FORMAT === 'json') return emit(data)
    process.stdout.write(renderContext(data, { fileOnly: Boolean(flags.file) }))
  },

  async map() {
    const dir = flags.dir ?? gitRoot(process.cwd()) ?? process.cwd()
    const key = positional[0]

    if (!key) {
      const map = readProjectMap()
      const rows = Object.entries(map).map(([path, k]) => ({ project: k, path }))
      return emit(
        { count: rows.length, here: projectForDir(process.cwd()) ?? '', rows },
        { rows: (d) => d.rows, columns: ['project', 'path'] },
      )
    }

    const map = readProjectMap()
    const repo = gitRemote(dir)
    let claimed = null

    if (key === 'none') {
      // Releasing the repository claim too, because `map <KEY>` made one.
      // Deleting only the local line left every clone of this repository —
      // including this one — still resolving, so `map none` reported success
      // and changed nothing observable: the silent failure this command was
      // just taught to stop producing.
      //
      // The claim belongs to a project, so we need the one that holds it: the
      // local line if there is one, and otherwise whatever the repository
      // itself currently resolves to, which is the case a fresh clone hits.
      const holder =
        map[dir] ??
        (repo
          ? (await request('GET', `/api/v1/context?repo=${encodeURIComponent(repo)}`, undefined, {
              soft: true,
            }))?.project
          : null)

      delete map[dir]

      if (repo && holder) {
        const released = await request(
          'DELETE',
          `/api/v1/projects/${holder}/repos?remote=${encodeURIComponent(repo)}`,
          undefined,
          { soft: true },
        )
        if (released) claimed = { released: repo, from: holder }
      }
    } else {
      // This used to write whatever it was handed. A mistyped key produced a
      // map that resolved to nothing, silently, for as long as it took someone
      // to wonder why the briefing had gone quiet.
      //
      // Store the key the server came back with rather than the spelling we
      // were given: this route resolves a uuid too, and a uuid in the map is 36
      // characters that every later /context rejects outright — which is the
      // same silence, reached by a route that looks like it validated.
      const project = await request('GET', `/api/v1/projects/${encodeURIComponent(key)}`)
      map[dir] = project.key

      // Claim the repository too, so a second clone, a moved directory and a
      // worktree all resolve without being mapped again. Soft: an older server
      // has no such route, and that is no reason to refuse the local mapping.
      if (repo) {
        const linked = await request(
          'POST',
          `/api/v1/projects/${project.key}/repos`,
          { remote: repo, rootCommit: gitRootCommit(dir) },
          { soft: true },
        )
        if (linked) claimed = { linked: repo, to: project.key }
      }
    }

    mkdirSync(dirname(PROJECT_MAP_PATH), { recursive: true })
    writeFileSync(PROJECT_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`)
    emit({ path: dir, project: map[dir] ?? null, repo, ...(claimed ?? {}) })
  },

  /**
   * Is the memory still being written?
   *
   * Prints the findings and nothing else when there are any, because a report
   * nobody reads is the same as no report. `--all` shows the counts behind
   * them. `--notify <ref>` posts the findings as a note and says nothing when
   * there are none, which is what makes it safe to run on a schedule.
   */
  async vitals() {
    const hours = Number(flags.hours ?? 24)
    const data = await request('GET', `/api/v1/vitals?hours=${hours}`)
    const findings = data.findings ?? []

    if (flags.notify) {
      if (findings.length === 0) {
        emit({ findings: 0, notified: false }, { lines: () => ['nothing to report'] })
        return
      }
      const note =
        `Cairn vitals, last ${data.windowHours}h:\n` +
        findings.map((f) => `  [${f.severity}] ${f.message}`).join('\n') +
        `\n\nSessions ${data.sessions.recent} (${data.sessions.recentWithFiles} naming files), ` +
        `tasks ${data.tasks.opened} opened / ${data.tasks.closed} closed, ` +
        `${data.tasks.stalled} stalled, ${data.autoReleased} claims auto-released.`
      await request('POST', `/api/v1/tasks/${encodeURIComponent(flags.notify)}/notes`, {
        note,
        kind: 'finding',
      })
      emit({ findings: findings.length, notified: true })
      return
    }

    emit(data, {
      lines: (d) => {
        const out = []
        if (d.findings.length === 0) out.push(`nothing wrong in the last ${d.windowHours}h`)
        for (const f of d.findings) out.push(`[${f.severity}] ${f.message}`)
        if (flags.all || d.findings.length === 0) {
          out.push('')
          out.push(
            `sessions ${d.sessions.recent} (${d.sessions.recentWithFiles} with files), ` +
              `week before ${d.sessions.baseline} (${d.sessions.baselineWithFiles})`,
          )
          out.push(
            `tasks ${d.tasks.opened} opened, ${d.tasks.closed} closed, ` +
              `${d.tasks.stalled} stalled, ${d.tasks.held} held`,
          )
          out.push(`claims auto-released ${d.autoReleased}, knowledge written ${d.knowledgeWritten}`)
          for (const a of d.agents) out.push(`  ${a.agent}: ${a.recent} writes (week before ${a.baseline})`)
        }
        return out
      },
    })
  },

  async reconcile() {
    const body = { dryRun: Boolean(flags['dry-run']) }
    if (flags.older) body.olderThanMinutes = Number(flags.older)
    const data = await request('POST', '/api/v1/reconcile', body)
    emit(
      { count: data.released.length, ...data },
      {
        rows: (d) =>
          d.released.map((r) => ({
            ref: r.ref,
            held: `${r.heldForMinutes}m`,
            checkpoint: r.hadCheckpoint ? 'yes' : 'none',
          })),
        columns: ['ref', 'held', 'checkpoint'],
      },
    )
  },

  // --- the episodic record -----------------------------------------------

  async session() {
    const verb = positional.shift() ?? 'list'

    if (verb === 'end') {
      const payload = {
        externalId: need(flags.id, 'usage: cairn session end --id <session-id>'),
        platformSource: flags.platform ?? 'claude',
        cwd: flags.cwd ?? process.cwd(),
        files: splitList(flags.files),
        taskRefs: splitList(flags.tasks),
      }
      for (const [flag, field] of [
        ['project', 'project'], ['agent', 'agentId'], ['request', 'request'],
        ['learned', 'learned'], ['completed', 'completed'], ['next', 'nextSteps'],
        ['started', 'startedAt'],
      ]) {
        if (flags[flag] !== undefined) payload[field] = await resolveValue(flags[flag])
      }
      if (flags['tool-calls']) payload.toolCalls = Number(flags['tool-calls'])
      if (flags['no-checkpoint']) payload.checkpointHeld = false
      if (flags.scheduled) payload.scheduled = true
      return emit(await request('POST', '/api/v1/sessions', payload))
    }

    if (verb === 'list') {
      const params = new URLSearchParams()
      if (flags.project) params.set('project', flags.project)
      if (flags.cwd) params.set('cwd', flags.cwd)
      if (flags.limit) params.set('limit', flags.limit)
      const data = await request('GET', `/api/v1/sessions?${params}`)
      return emit(data, {
        // What came of it, not only what was asked. A list of requests is a
        // list of intentions; the reason to keep a session is the answer.
        rows: (d) => d.results.map((r) => ({
          ended: (r.endedAt ?? '').slice(0, 16).replace('T', ' '),
          agent: r.agent ?? r.platform,
          files: r.files,
          tasks: (r.taskRefs ?? []).join(','),
          request: truncate(r.request ?? (r.scheduled ? 'scheduled run' : ''), 44),
          outcome: truncate(r.completed ?? r.learned ?? '', 52),
        })),
        columns: ['ended', 'agent', 'files', 'tasks', 'request', 'outcome'],
      })
    }

    die(`unknown session verb "${verb}" — try: end, list`)
  },
}

const command = positional.shift()

if (flags.version || command === 'version') {
  // Asks the server too, and says when they disagree. A stale copy is
  // invisible otherwise: it goes on working, just not the way the docs say.
  let server = null
  try {
    const res = await fetch(`${BASE}/api/v1/health`)
    server = (await res.json())?.data ?? null
  } catch {
    // Offline, or not pointed at a server yet. The local version still answers.
  }
  process.stdout.write(`cairn ${VERSION}\n`)
  if (server) {
    process.stdout.write(`server ${server.version ?? '?'} (${server.build ?? '?'}) ${BASE}\n`)
    if (server.version && server.version !== VERSION) {
      process.stderr.write(
        `\nthis CLI is ${VERSION}, the server is ${server.version} — ` +
          `run scripts/sync-agent-files.mjs, or copy cli/cairn.mjs over\n`,
      )
    }
  }
  process.exit(0)
}

if (!command || flags.help || command === 'help') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (!commands[command]) {
  die(`unknown command "${command}"\n\nvalid: ${Object.keys(commands).sort().join(' ')}`)
}
await commands[command]()
