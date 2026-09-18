import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { listFormerKeys } from '@/lib/api/project-keys'
import { CommandPalette } from '@/components/command-palette'
import { AppSidebar } from '@/components/app-sidebar'
import { TaskCreationProvider } from '@/components/task-creation'
import { Shortcuts } from '@/components/shortcuts'
import { ProjectKeysProvider } from '@/components/project-keys'
import { MobileNavProvider } from '@/components/mobile-nav-context'
import { ToastHost } from '@/components/toast'
import { HealthBanner } from '@/components/health-banner'
import { LiveStatusIndicator, LiveStatusProvider } from '@/components/live-status'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware enforces this; a layout renders data and should not assume
  // the guard ran.
  if (!user) redirect('/login')

  const [projects, formerKeys] = await Promise.all([
    listProjects(user.id),
    listFormerKeys(user.id),
  ])
  const email = user.email ?? 'you'
  const projectList = projects.map((p) => ({ key: p.key, title: p.title }))

  // Retired keys linkify too. A bare `ACME-42` in a task body or an agent's
  // note is matched by pattern against this list, so after a rename it still
  // looked like a ref, was still a link, and led nowhere — the memory store
  // breaking its own cross-references.
  const refKeys = [...projectList.map((p) => p.key), ...formerKeys.map((f) => f.key)]

  return (
    <ToastHost>
      <LiveStatusProvider>
      <ProjectKeysProvider keys={refKeys}>
        <TaskCreationProvider projects={projectList}>
          <MobileNavProvider email={email} role={user.role} projects={projectList}>
            <div className="bg-bg flex h-dvh">
              <aside className="border-border bg-bg-elevated hidden w-[13.75rem] shrink-0 flex-col border-r md:flex">
                <AppSidebar email={email} role={user.role} projects={projectList} />
              </aside>

              {/* Beside the content, not above the sidebar: the shell is a flex
                row, and a banner spanning it would push the whole app down. */}
            <div className="flex min-w-0 flex-1 flex-col">
              <HealthBanner userId={user.id} />
              <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
            </div>
              <CommandPalette projects={projectList} />
              <Shortcuts />
              {/* Fixed to the viewport, outside the scroll containers each
                  page owns, so it stays put wherever the reader is. */}
              <LiveStatusIndicator />
            </div>
          </MobileNavProvider>
        </TaskCreationProvider>
      </ProjectKeysProvider>
      </LiveStatusProvider>
    </ToastHost>
  )
}

export default AppLayout
