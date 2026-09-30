/**
 * OpenClaw's half of "inject the briefing at session start".
 *
 * OpenClaw has no session-start hook that can return text. What it has is
 * `agent:bootstrap`, fired before the workspace's bootstrap files are injected,
 * with `context.bootstrapFiles` open to mutation. So the briefing arrives as
 * one more bootstrap file: a short rule, then live `cairn context` output for
 * the agent's workspace.
 *
 * The rule travels with the data because it is the one piece of the lifecycle
 * an OpenClaw agent reliably sees. Its AGENTS.md is hand-maintained per
 * machine and drifts; the skill is read in about half of sessions. A briefing
 * that carried data only told the agent what exists, never what to do next.
 *
 * Trig and Croft, when this machine has them, follow in a few lines each, as
 * they do in hooks/cairn-context.mjs: Cairn owns the opening and names its
 * siblings, each on a 1.5 s deadline of its own and silent on any failure.
 *
 * Same rules as hooks/cairn-context.mjs: never block (a 5 s deadline, and every
 * failure leaves the session starting as it would have without this hook), and
 * stay small. Unlike that hook it still injects the rule when the CLI fails,
 * because an agent that cannot reach Cairn should still know how to use it.
 *
 * No imports from OpenClaw: the hook is linked from outside its tree, so the
 * types below are the subset of its documented event this reads.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

type BootstrapFile = { name: string; path: string; content?: string; missing: boolean }

type HookEvent = {
  type: string
  action: string
  context?: { workspaceDir?: unknown; bootstrapFiles?: unknown }
}

export const FILE_NAME = 'CAIRN.md'

export const RULE = `## Cairn — live briefing
Durable work (a fix, config change, deploy, migration, investigation, delegation): \`cairn check "<subject>"\` first, and \`show\` the hits that matter.
- Own it: \`cairn add "<title>" --project <KEY> --type <type> --body -\` (claims by default for agents; assigned to your human unless \`--assignee <who>\`) or \`cairn claim <ref>\`. Exit 9 = another agent holds it: pick other work.
- Bodies are markdown: \`##\` headings, lists, paths and calls in backticks; a wall of text is refused.
- Record: \`cairn note <ref> "…" --kind attempt|finding|decision|handoff\`. Dead ends are \`attempt\`.
- \`cairn checkpoint <ref> --summary "state + next step"\` before yielding. Written but not landed: \`cairn update <ref> --status in-review\`.
- Close: \`cairn done <ref> --resolution "…" --kind fixed|verified|answered|wont-fix|duplicate|superseded\` (\`verified\` when the fix was already there).
- Sweeping a backlog: claim one task for the sweep, note on the rest. Not for trivia, or work another agent holds.
- \`cairn learn\` needs \`--project\`, \`--entity\` or \`--global\` outside a mapped checkout.`

const timeoutMs = () => {
  const value = Number(process.env.CAIRN_HOOK_TIMEOUT_MS ?? 5000)
  return Number.isFinite(value) && value > 0 ? value : 5000
}

/** `cairn context` for the workspace, or '' on any failure, never slower than the deadline. */
export const briefing = (cwd: string): Promise<string> =>
  new Promise((resolve) => {
    const cli = process.env.CAIRN_CLI?.trim() || 'cairn'
    try {
      execFile(
        cli,
        ['context', '--cwd', cwd],
        {
          cwd,
          timeout: timeoutMs(),
          maxBuffer: 1024 * 1024,
          env: { ...process.env, CAIRN_AGENT: process.env.CAIRN_AGENT || 'openclaw' },
        },
        (error, stdout) => resolve(error ? '' : String(stdout).trim()),
      )
    } catch {
      resolve('')
    }
  })

const SUMMARISER_FLAGS = ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER', 'CROFT_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']
const CROFT_MAX_LINES = 5
const CROFT_MAX_BYTES = 600

const siblingTimeout = (name: string) => {
  const value = Number(process.env[name] ?? 1500)
  return Number.isFinite(value) && value > 0 ? value : 1500
}

/** stdout of a sibling CLI, or '' on any failure, never slower than its deadline. */
const quiet = (bin: string, args: string[], cwd: string, timeout: number): Promise<string> =>
  new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }, (error, stdout) => {
        clearTimeout(deadline)
        resolve(error ? '' : String(stdout).trim())
      })
      // execFile answers only once the pipes close, and a process the sibling
      // forked keeps them open after the kill; the deadline is ours to keep.
      const deadline = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve('')
      }, timeout + 100)
    } catch {
      resolve('')
    }
  })

/** Where Croft's installer puts it, for a gateway whose PATH lacks ~/.local/bin. */
const croftCli = () => {
  const env = process.env.CROFT_CLI?.trim()
  if (env) return env
  if ((process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, 'croft')))) return 'croft'
  const local = join(homedir(), '.local', 'bin', 'croft')
  return existsSync(local) ? local : 'croft'
}

/** One line about the map, or ''. */
export const trigLine = async (cwd: string): Promise<string> => {
  const bin = process.env.TRIG_CLI?.trim() || 'trig'
  const out = await quiet(bin, ['scans', '--limit', '1', '--json'], cwd, siblingTimeout('CAIRN_TRIG_TIMEOUT_MS'))
  if (!out) return ''
  try {
    const rows = JSON.parse(out)
    const last = Array.isArray(rows) ? rows[0] : (rows?.data ?? rows?.results ?? [])[0]
    if (!last) return ''
    const when = last.finishedAt ?? last.finished_at ?? last.startedAt ?? last.started_at
    const age = when ? Math.round((Date.now() - new Date(when).getTime()) / 3_600_000) : null
    const scanned = age === null ? 'scanned at an unknown time' : age < 1 ? 'scanned within the hour' : `scanned ${age}h ago`
    return `Trig — the map of what exists (${scanned}):\n  trig what-is <thing> · trig impact <thing> · trig inbox`
  } catch {
    return ''
  }
}

/** Croft's own brief for the workspace, clipped, or ''. */
export const croftBlock = async (cwd: string): Promise<string> => {
  const out = await quiet(croftCli(), ['context', '--brief', '--cwd', cwd], cwd, siblingTimeout('CAIRN_CROFT_TIMEOUT_MS'))
  if (!out) return ''
  const lines = out.split('\n').slice(0, CROFT_MAX_LINES)
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > CROFT_MAX_BYTES) lines.pop()
  return Buffer.from(lines.join('\n')).subarray(0, CROFT_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '').trimEnd()
}

/** Every sibling's block, in order, or [] under a summariser. */
export const siblings = async (cwd: string): Promise<string[]> => {
  if (SUMMARISER_FLAGS.some((name) => process.env[name] === '1')) return []
  return (await Promise.all([trigLine(cwd), croftBlock(cwd)])).filter(Boolean)
}

const handler = async (event: HookEvent): Promise<void> => {
  if (event?.type !== 'agent' || event.action !== 'bootstrap') return
  const context = event.context
  if (!context || typeof context.workspaceDir !== 'string' || !Array.isArray(context.bootstrapFiles)) return

  try {
    const workspaceDir = context.workspaceDir
    const [live, extra] = await Promise.all([briefing(workspaceDir), siblings(workspaceDir)])
    const files = (context.bootstrapFiles as BootstrapFile[]).filter((f) => f?.name !== FILE_NAME)
    files.push({
      name: FILE_NAME,
      path: join(workspaceDir, FILE_NAME),
      content: [RULE, live, ...extra].filter(Boolean).join('\n\n'),
      missing: false,
    })
    context.bootstrapFiles = files
  } catch {
    // Fail open: the session starts exactly as it would have without this hook.
  }
}

export default handler
