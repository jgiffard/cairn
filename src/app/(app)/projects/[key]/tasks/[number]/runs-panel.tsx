import { RelativeTime } from '@/components/relative-time'
import type { TaskRun } from '@/lib/runs'
import { cn } from '@/lib/utils'
import { COUNT, LABEL } from './styles'

/** Only http(s) earns an href: older rows may predate the server's check. */
const safeUrl = (value: string | null): string | null => {
  if (!value) return null
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/** The stored repo may be a local absolute path: only its last segment is worth showing. */
const repoName = (repo: string): string => repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? repo

const prLabel = (url: string): string => {
  const number = url.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1]
  if (number) return `#${number}`
  try {
    const { host, pathname } = new URL(url)
    return `${host}${pathname}`
  } catch {
    return url
  }
}

const CHECK_TONE: Record<string, string> = {
  passed: 'var(--status-done)',
  failed: 'var(--danger)',
  skipped: 'var(--fg-subtle)',
}

const LINK = 'text-accent decoration-accent/50 underline-offset-[3px] hover:underline rounded-sm'

const ExternalLink = ({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: React.ReactNode
}) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK, className)}>
    {children}
  </a>
)

/**
 * The runs that worked this task (CAIRN-427), newest first: one block per
 * run, built from its run-tagged activity. Absent when there are none.
 */
export const RunsPanel = ({ runs }: { runs: TaskRun[] }) => {
  if (runs.length === 0) return null

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5')}>
        Runs
        <span className={COUNT}>{runs.length}</span>
      </h2>
      <ul className="flex flex-col gap-4">
        {runs.map((run) => {
          const runHref = safeUrl(run.url)
          const hasDetail = run.commits.length + run.prs.length + run.checks.length > 0
          return (
            <li key={run.id} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui">
                {runHref ? (
                  <ExternalLink href={runHref} className="max-w-full min-w-0 truncate font-mono">
                    <span title={run.id}>{run.id}</span>
                  </ExternalLink>
                ) : (
                  <span className="text-fg max-w-full min-w-0 truncate font-mono" title={run.id}>
                    {run.id}
                  </span>
                )}
                {run.runner ? <span className="text-fg-muted">{run.runner}</span> : null}
                {run.state ? (
                  <span className="border-border bg-surface-raised text-fg-muted rounded-full border px-1.5 text-meta">
                    {run.state}
                  </span>
                ) : null}
                <RelativeTime iso={run.lastAt} className="text-fg-subtle text-meta tabular" />
              </div>
              {run.seats.length > 0 ? (
                <p className="text-fg-subtle mt-0.5 min-w-0 text-meta break-words">
                  Seats: {run.seats.join(', ')}
                </p>
              ) : null}
              {hasDetail ? (
                <div className="border-border mt-1.5 flex flex-col gap-1 border-l pl-3.5">
                  {run.commits.length > 0 ? (
                    <ul aria-label="Commits" className="flex flex-col gap-0.5">
                      {run.commits.map((c) => {
                        const href = safeUrl(c.url)
                        const sha = c.sha.slice(0, 7)
                        return (
                          <li key={c.sha} className="flex min-w-0 items-baseline gap-2 text-meta">
                            {href ? (
                              <ExternalLink href={href} className="shrink-0 font-mono">
                                {sha}
                              </ExternalLink>
                            ) : (
                              <span className="text-fg shrink-0 font-mono">{sha}</span>
                            )}
                            {c.repo ? (
                              <span className="text-fg-muted max-w-[40%] shrink-0 truncate">
                                {repoName(c.repo)}
                              </span>
                            ) : null}
                            {c.branch ? (
                              <span className="text-fg-subtle min-w-0 truncate" title={c.branch}>
                                {c.branch}
                              </span>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                  {run.prs.length > 0 ? (
                    <ul aria-label="Pull requests" className="flex flex-wrap gap-x-3 text-meta">
                      {run.prs.map((url) => {
                        const href = safeUrl(url)
                        return (
                          <li key={url} className="max-w-full min-w-0 truncate">
                            {href ? (
                              <ExternalLink href={href}>{prLabel(url)}</ExternalLink>
                            ) : (
                              <span className="text-fg-muted">{prLabel(url)}</span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                  {run.checks.length > 0 ? (
                    <ul aria-label="Checks" className="flex flex-col gap-0.5">
                      {run.checks.map((check) => (
                        <li
                          key={`${check.command}-${check.at}`}
                          className="flex min-w-0 items-baseline gap-2 text-meta"
                        >
                          <code className="text-fg-muted min-w-0 truncate font-mono" title={check.command}>
                            {check.command}
                          </code>
                          <span
                            className="shrink-0 font-medium"
                            style={{ color: CHECK_TONE[check.status] ?? 'var(--fg-muted)' }}
                          >
                            {check.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
