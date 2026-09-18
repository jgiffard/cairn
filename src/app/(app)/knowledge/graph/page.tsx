import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { LiveUpdates } from '@/components/live-updates'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { currentUser } from '@/lib/data'
import { knowledgeGraph } from '@/lib/api/knowledge-graph'
import { GraphView } from './graph-view'

export const dynamic = 'force-dynamic'

/**
 * The corpus as a map, and specifically as a map of what it is NOT joined to.
 *
 * Built after counting the edges in the model and finding only one real graph
 * in it: the `[[slug]]` references between knowledge entries. Everything
 * relational is a tree or a fan — two dependency edges across three thousand
 * tasks — so this draws the one structure that has a shape worth seeing.
 *
 * As navigation it would be decoration; the references have been clickable
 * since CAIRN-192 and one click beats hunting a dot. What earns it is the
 * other half: a quarter of the corpus is joined to nothing, it falls into
 * nineteen separate islands, and dozens of references point at entries nobody
 * ever wrote. None of that appears in a list, because a list shows what is
 * there.
 */
const KnowledgeGraphPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const graph = await knowledgeGraph()
  const { stats } = graph

  const figures: [string, string, string][] = [
    [`${stats.entries}`, 'entries', ''],
    [`${graph.edges.length}`, 'links', `${stats.withReferences} entries reference another`],
    [
      `${stats.islands}`,
      stats.islands === 1 ? 'island' : 'islands',
      graph.islands.length > 0 ? `largest holds ${graph.islands[0]}` : '',
    ],
    [
      `${stats.isolated}`,
      'joined to nothing',
      stats.entries > 0 ? `${Math.round((stats.isolated / stats.entries) * 100)}% of the corpus` : '',
    ],
    [
      `${graph.missing.length}`,
      'never written',
      stats.dangling > 0 ? `${stats.dangling} references point at them` : '',
    ],
  ]

  return (
    <div className="flex h-dvh flex-col">
      {/* agents write knowledge while you are reading it */}
      <LiveUpdates />
      <header className="border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-[0.8125rem] transition-colors sm:block"
        >
          Cairn
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <Link href="/knowledge" className="text-fg-muted hover:text-fg text-[0.8125rem]">
          Knowledge
        </Link>
        <ChevronRight size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-fg text-[0.8125rem]">Map</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3 md:px-4">
        <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {figures.map(([value, label, note]) => (
            <div key={label} className="border-border bg-surface rounded-lg border px-3 py-2">
              <dt className="text-fg-subtle text-[0.7rem]">{label}</dt>
              <dd className="text-fg text-[1.25rem] leading-tight font-medium tabular">{value}</dd>
              {note ? <p className="text-fg-subtle text-[0.68rem]">{note}</p> : null}
            </div>
          ))}
        </dl>

        <GraphView graph={graph} />

        <p className="text-fg-subtle mt-3 max-w-prose text-[0.75rem] leading-relaxed">
          Each dot is an entry, sized by how many others it is joined to and coloured by its
          project. Islands are laid out separately, so a cluster on its own really is on its
          own. The loose grid underneath is everything joined to nothing at all. A dashed red
          ring is a reference to an entry nobody ever wrote — it is drawn beside whoever
          pointed at it rather than dropped, which is how these stayed invisible.
        </p>
      </div>
    </div>
  )
}

export default KnowledgeGraphPage
