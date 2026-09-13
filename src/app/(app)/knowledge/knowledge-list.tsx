import Link from 'next/link'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { LabelPill, ProjectIcon } from '@/components/icons'
import { shortDate, fullDateTime } from '@/lib/dates'
import { cn } from '@/lib/utils'

export type KnowledgeListItem = {
  slug: string
  title: string
  labels: string[]
  projects: string[]
  entities: string[]
  verified: boolean
  updatedAt: string
  superseded: boolean
  /** The replacement to link to. Known for a browse row; a search hit only
   *  knows the boolean above, since search_all does not carry the id. */
  supersededByRef: { slug: string; title: string } | null
  /** Only set when a project filter narrowed the query. */
  scope?: 'project' | 'entity' | 'global'
  /** Set on a search hit; not carried by a browse row. */
  loose?: boolean
}

/**
 * How widely a fact applies, in one shape.
 *
 * A project used to render as an icon and a key, an entity as bare text, and
 * global as a grey italic word — three treatments for one field, so the column
 * read as three unrelated things rather than one answer at three widths.
 */
const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="border-border bg-surface text-fg-muted inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] whitespace-nowrap">
    {children}
  </span>
)

const Scope = ({ item }: { item: KnowledgeListItem }) => {
  if (item.projects.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {item.projects.map((p) => (
          <Chip key={p}>
            <ProjectIcon size={10} projectKey={p} />
            {p}
          </Chip>
        ))}
      </span>
    )
  }
  if (item.entities.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {item.entities.map((e) => (
          <Chip key={e}>
            <span className="bg-fg-subtle size-[5px] rounded-full" aria-hidden />
            {e}
          </Chip>
        ))}
      </span>
    )
  }
  return (
    <Chip>
      <span className="bg-fg-subtle size-[5px] rounded-full opacity-60" aria-hidden />
      everywhere
    </Chip>
  )
}

export const KnowledgeList = ({ items }: { items: KnowledgeListItem[] }) => (
  <ul className="divide-border divide-y">
    {items.map((item) => (
      <li key={item.slug} className="group relative">
        <Link
          href={`/knowledge/${item.slug}`}
          prefetch
          aria-label={item.title}
          className="absolute inset-0 z-0"
        />
        <div className="hover:bg-surface-hover flex min-w-0 flex-col gap-1 px-3 py-2.5 transition-colors sm:px-4">
          <div className="pointer-events-none flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                item.superseded ? 'text-fg-muted line-through decoration-1' : 'text-fg',
              )}
            >
              {item.title}
            </span>
            {item.verified && (
              <span title="Verified" className="text-status-in-review shrink-0">
                <ShieldCheck size={13} aria-hidden />
              </span>
            )}
            <time
              dateTime={item.updatedAt}
              title={fullDateTime(item.updatedAt)}
              className="text-fg-subtle tabular hidden shrink-0 text-[12px] sm:block"
            >
              {shortDate(item.updatedAt)}
            </time>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="pointer-events-none">
              <Scope item={item} />
            </span>
            {item.labels.length > 0 && (
              <span className="pointer-events-none flex flex-wrap items-center gap-1">
                {item.labels.slice(0, 4).map((l) => (
                  <LabelPill key={l}>{l}</LabelPill>
                ))}
                {item.labels.length > 4 && (
                  <span className="text-fg-subtle">+{item.labels.length - 4}</span>
                )}
              </span>
            )}
            {item.loose && <span className="text-fg-subtle italic">loose match</span>}
            {item.superseded &&
              (item.supersededByRef ? (
                <Link
                  href={`/knowledge/${item.supersededByRef.slug}`}
                  prefetch
                  className="text-accent pointer-events-auto relative z-10 inline-flex items-center gap-1 hover:underline"
                >
                  <ArrowRight size={11} aria-hidden />
                  superseded by {item.supersededByRef.title}
                </Link>
              ) : (
                <span className="text-fg-subtle pointer-events-none italic">superseded</span>
              ))}
          </div>
        </div>
      </li>
    ))}
  </ul>
)
