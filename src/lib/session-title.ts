/**
 * What to show as a session's headline.
 *
 * A session's `request` is the first thing the human asked. On a runtime that
 * wakes itself it often is not: OpenClaw opens a scheduled run with
 * `[cron:<uuid> memory-auto-extract] Run the memory extraction routine…`, or a
 * raw JSON context blob, or the contents of its instruction file. Nineteen of
 * twenty-three sessions were titled that way, which made the page unreadable.
 *
 * The hook no longer records those as the request, but the rows already
 * written are not noise — fifteen of them touched real files and five worked
 * real tasks. Deleting them would throw that away to tidy a headline, so the
 * display falls back instead: what the session actually completed, else where
 * it left off, else an honest label.
 */
const MACHINE_PROMPT = /^(\[cron:[0-9a-f-]{8,}|Conversation info:|#+\s*AGENTS\.md|<INSTRUCTIONS>)/i

export const isMachinePrompt = (request: string | null | undefined): boolean =>
  Boolean(request && MACHINE_PROMPT.test(request.trim()))

export const sessionTitle = (session: {
  request?: string | null
  completed?: string | null
  nextSteps?: string | null
}): { text: string; machine: boolean } => {
  if (!isMachinePrompt(session.request)) {
    return { text: session.request?.trim() || 'No request recorded.', machine: false }
  }
  const fallback = session.completed?.trim() || session.nextSteps?.trim()
  return { text: fallback || 'Scheduled run', machine: true }
}
