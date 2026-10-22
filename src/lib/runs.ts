export type RunActivity = {
  event: string
  data: Record<string, unknown> | null
  created_at: string
}

export type TaskRun = {
  id: string
  runner: string | null
  url: string | null
  state: string | null
  seats: string[]
  commits: { sha: string; repo: string | null; branch: string | null; url: string | null; at: string }[]
  prs: string[]
  checks: { command: string; status: string; at: string }[]
  firstAt: string
  lastAt: string
}

const string = (value: unknown): string | null => typeof value === 'string' ? value : null

/** Work chronologically for seat appearance; collect delivery evidence newest first. */
export const groupRuns = (rows: readonly RunActivity[]): TaskRun[] => {
  const groups = new Map<string, RunActivity[]>()
  for (const row of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const run = row.data?.run as Record<string, unknown> | undefined
    if (!run || typeof run.id !== 'string' || !run.id) continue
    const group = groups.get(run.id) ?? []
    group.push(row)
    groups.set(run.id, group)
  }
  return [...groups].map(([id, activity]) => {
    const result: TaskRun = {
      id, runner: null, url: null, state: null, seats: [], commits: [], prs: [], checks: [],
      firstAt: activity[0]!.created_at, lastAt: activity[activity.length - 1]!.created_at,
    }
    for (const row of activity) {
      const run = row.data!.run as Record<string, unknown>
      if (typeof run.runner === 'string') result.runner = run.runner
      if (typeof run.url === 'string') result.url = run.url
      if (row.event === 'run_link') result.state = string(run.state)
      const seats = [...(Array.isArray(run.seats) ? run.seats : []), run.seat]
      for (const seat of seats) {
        if (typeof seat === 'string' && !result.seats.includes(seat)) result.seats.push(seat)
      }
    }
    for (const row of [...activity].reverse()) {
      const data = row.data!
      if (row.event === 'git_commit' || row.event === 'git_push') {
        const url = string(data.url)
        if (url && /\/(?:pull|merge_requests)\/\d+(?:[/?#]|$)/.test(url) && !result.prs.includes(url)) result.prs.push(url)
        if (typeof data.sha === 'string' && !result.commits.some((c) => c.sha === data.sha)) {
          result.commits.push({ sha: data.sha, repo: string(data.repo), branch: string(data.branch), url, at: row.created_at })
        }
      }
      if (row.event === 'run_result' && typeof data.command === 'string' && typeof data.status === 'string') {
        result.checks.push({ command: data.command, status: data.status, at: row.created_at })
      }
    }
    return result
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}
