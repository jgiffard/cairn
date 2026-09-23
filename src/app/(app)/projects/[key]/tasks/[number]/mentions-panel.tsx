import Link from 'next/link'
import { StatusIcon } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import type { Mention } from '@/lib/api/mentions'
import type { TaskStatus } from '@/schemas/task'

const taskHref = (ref: string) =>
  `/projects/${ref.slice(0, ref.lastIndexOf('-'))}/tasks/${ref.slice(ref.lastIndexOf('-') + 1)}`

/**
 * Where other tasks named this one (CAIRN-267), decisions and findings first.
 * Absent when there are none: an empty "mentioned nowhere" section says
 * nothing a reader needs.
 */
export const MentionsPanel = ({ total, mentions }: { total: number; mentions: Mention[] }) => {
  if (mentions.length === 0) return null

  return (
    <section>
      <h2 className="text-fg-subtle mb-2 text-[0.6875rem] font-medium">
        Mentioned in · {total}
        {total > mentions.length ? ` (the ${mentions.length} that matter most)` : ''}
      </h2>
      <ul className="flex flex-col gap-3">
        {mentions.map((m) => (
          <li key={`${m.ref}-${m.source}-${m.at}`} className="text-[0.78125rem]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <StatusIcon status={m.status as TaskStatus} size={12} />
              <Link href={taskHref(m.ref)} prefetch className="text-accent tabular hover:underline">
                {m.ref}
              </Link>
              <span className="text-fg min-w-0 truncate">{m.title}</span>
              <span className="text-fg-subtle text-[0.6875rem]">
                {m.kind ?? m.source}
                {m.by ? ` · ${m.by}` : ''} · <RelativeTime iso={m.at} />
              </span>
            </div>
            <p className="text-fg-muted border-border mt-1 border-l-2 pl-2.5">{m.excerpt}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
