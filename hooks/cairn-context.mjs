#!/usr/bin/env node
/**
 * The inject-without-being-queried half of Cairn's memory.
 *
 * Reads a hook payload on stdin and prints the runtime's context response.
 * Claude Code and Codex share a wire format. Hermes Agent by Nous Research
 * injects context from `pre_llm_call`, whose response protocol is different.
 *
 * Three rules govern everything here:
 *
 *   1. Never block. A memory system that can stop a session from starting is
 *      worse than no memory system. Every failure path prints nothing and
 *      exits 0.
 *   2. Never speak when there is nothing to say. An empty heading every
 *      session trains the reader to skip the block, which is how a 12 KB
 *      digest ends up being consulted a hundred times in seventeen days.
 *   3. Stay small. This is a briefing, not a corpus.
 */
import { spawn } from 'node:child_process'

const TIMEOUT_MS = Number(process.env.CAIRN_HOOK_TIMEOUT_MS ?? 4000)
const CLI = process.env.CAIRN_CLI ?? 'cairn'

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/** Runs the CLI with a hard deadline, and treats every failure as "say nothing". */
const run = (args) =>
  new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const child = spawn(CLI, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done('')
    }, TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', () => {
      clearTimeout(timer)
      done('')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 ? out : '')
    })
  })

const main = async () => {
  const payload = await readStdin()
  const event = payload.hook_event_name ?? 'SessionStart'
  const cwd = payload.cwd ?? process.cwd()

  // Hermes Agent by Nous Research invokes pre_llm_call for every turn. Its
  // first turn is the session-start equivalent; later injection would waste
  // context and break prompt-cache stability.
  //
  // The docs give is_first_turn as a callback parameter and say `extra` carries
  // the event's kwargs, without showing a payload, so read both. If it is in
  // neither, we cannot tell "not the first turn" from "this build does not send
  // it", and staying silent would mean never briefing at all with nothing to
  // find. Say so on stderr, which Hermes logs and the user message never sees.
  if (event === 'pre_llm_call') {
    const isFirstTurn = payload.extra?.is_first_turn ?? payload.is_first_turn
    if (isFirstTurn === undefined) {
      process.stderr.write('cairn: pre_llm_call payload carries no is_first_turn, in extra or at top level — no briefing will ever be injected\n')
      return
    }
    if (isFirstTurn !== true) return
  }

  const args = ['context', '--cwd', cwd]

  // PreToolUse on a read: the question is about this file, not the project.
  if (event === 'PreToolUse') {
    const path = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path
    if (!path) return
    args.push('--file', path)
  }

  const text = (await run(args)).trim()
  if (!text) return

  if (event === 'pre_llm_call') {
    process.stdout.write(`${JSON.stringify({ context: text })}\n`)
    return
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
      suppressOutput: true,
    })}\n`,
  )
}

main().catch(() => {})
