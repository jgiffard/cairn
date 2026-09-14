import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { admin } from '@/lib/db/client'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { LiveUpdates } from '@/components/live-updates'
import { ProjectsManager } from './projects-manager'

export const dynamic = 'force-dynamic'

/**
 * Projects, as something you can change.
 *
 * Creating one meant the API or the CLI, and renaming or archiving meant the
 * same — so the only way to tidy the thing you look at every day was to leave
 * it. The sidebar lists projects and has never been able to add one.
 */
const ProjectsPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const projects = await listProjects(user.id, { includeArchived: true })

  // Live counts, not `task_counter`: that is the next number to issue, so a
  // project whose tasks were all deleted still reports the high-water mark.
  const { data: counts } = await admin()
    .from('tasks')
    .select('project_id, status, project:projects!project_id!inner(owner_user_id)')
    .eq('projects.owner_user_id', user.id)
    .limit(5000)

  const open = new Map<string, number>()
  const total = new Map<string, number>()
  for (const row of (counts ?? []) as { project_id: string; status: string }[]) {
    total.set(row.project_id, (total.get(row.project_id) ?? 0) + 1)
    if (row.status !== 'done' && row.status !== 'cancelled') {
      open.set(row.project_id, (open.get(row.project_id) ?? 0) + 1)
    }
  }

  const rows = projects.map((p) => ({
    id: p.id,
    key: p.key,
    title: p.title,
    description: p.description,
    status: p.status,
    open: open.get(p.id) ?? 0,
    total: total.get(p.id) ?? 0,
  }))

  return (
    <div className="flex h-dvh flex-col">
      <LiveUpdates />
      <header className="border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <h1 className="text-fg text-[0.8125rem] font-medium">Projects</h1>
        <span className="text-fg-subtle text-[0.75rem]">
          {rows.filter((r) => r.status !== 'archived').length} active
          {rows.some((r) => r.status === 'archived')
            ? ` · ${rows.filter((r) => r.status === 'archived').length} archived`
            : ''}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[56rem] px-4 py-6 sm:px-6">
          <ProjectsManager projects={rows} />
        </div>
      </div>
    </div>
  )
}

export default ProjectsPage
