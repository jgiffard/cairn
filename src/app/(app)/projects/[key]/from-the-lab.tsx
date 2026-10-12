import Link from 'next/link'
import { StageBadge } from '@/components/lab/stage'
import { subjectHref, type SubjectSummary } from '@/components/lab/types'

/** The panel lists this many, then points at the Lab for the rest. */
export const FROM_THE_LAB_SHOWN = 3

type LabSubject = Pick<SubjectSummary, 'number' | 'ref' | 'title' | 'stage' | 'archived_at'>

const ROW_LINK =
  'hover:bg-surface-hover/70 hover:text-fg -mx-2 flex min-h-[1.75rem] items-center gap-2 rounded-md px-2 text-ui transition-colors duration-100 ease-[var(--ease)]'

/**
 * The Lab subjects that belong to this project. A promoted subject is archived
 * (CAIRN-408): it is listed as history, the why behind the project, read-only
 * here and linked to its page. A live subject still linked from before
 * promotion concluded subjects is listed first, with its stage. Drawn by the
 * page only where the
 * Lab is on, and not at all for a project the Lab has not touched: a panel
 * that always says "nothing" is noise on every page.
 */
export const FromTheLab = ({ projectKey, subjects }: { projectKey: string; subjects: LabSubject[] }) => {
  if (subjects.length === 0) return null
  const ordered = [...subjects.filter((s) => !s.archived_at), ...subjects.filter((s) => s.archived_at)]
  const shown = ordered.slice(0, FROM_THE_LAB_SHOWN)
  const rest = ordered.length - shown.length

  return (
    <section aria-labelledby="from-the-lab" className="min-w-0">
      <h2 id="from-the-lab" className="text-fg-subtle pb-1 text-meta font-medium">
        From the Lab
      </h2>
      <ul>
        {shown.map((subject) => (
          <li key={subject.number}>
            <Link
              href={subjectHref(subject.number)}
              className={`${ROW_LINK} ${subject.archived_at ? 'text-fg-subtle' : 'text-fg-muted'}`}
              title={subject.archived_at ? `${subject.ref}: ${subject.stage.name}, archived` : undefined}
            >
              <span className="text-fg-subtle shrink-0 font-mono text-meta">{subject.ref}</span>
              <span className="min-w-0 flex-1 truncate">{subject.title}</span>
              {subject.archived_at ? (
                <span className="text-fg-subtle max-w-[40%] shrink-0 truncate text-meta">{subject.stage.name}</span>
              ) : (
                <StageBadge stage={subject.stage} className="text-fg-subtle max-w-[40%] shrink-0 text-meta" />
              )}
            </Link>
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <Link
          href={`/lab?project=${encodeURIComponent(projectKey)}&archived=include`}
          className="text-fg-subtle hover:text-fg mt-1 inline-block text-meta transition-colors"
        >
          {rest} more in the Lab
        </Link>
      ) : null}
    </section>
  )
}
