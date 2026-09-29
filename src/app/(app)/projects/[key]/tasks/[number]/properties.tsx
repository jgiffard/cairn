'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, StatusIcon, TypePill } from '@/components/icons'
import { usePeople } from '@/components/people-context'
import { ResolutionDialog } from '../../resolution-dialog'
import { AlsoIn } from './also-in'
import { DependencyEditor } from './dependency-editor'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  isTerminal,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/schemas/task'
import { cn } from '@/lib/utils'
import { shortDateWithYear } from '@/lib/dates'
import { RelativeTime } from '@/components/relative-time'
import { useRenderedClaimStale } from '@/lib/use-mounted'
import type { Task, Project, Relation } from '@/lib/data'
import { useMutate } from '@/lib/api/use-mutate'
import { LABEL } from './styles'

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const Section = ({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    <span className={LABEL}>{title}</span>
    {children}
  </div>
)

/**
 * An editable value: the row lights as a list row does — a fill and the trail
 * marker — and a chevron surfaces to say it opens. Keyboard focus on the
 * invisible select lights it the same way, since the select itself cannot show
 * a ring.
 */
const EDITABLE =
  'row-hover group/edit relative -mx-1.5 flex h-[1.75rem] items-center gap-2 rounded-md px-1.5 ' +
  'has-[:focus-visible]:bg-surface-hover has-[:focus-visible]:shadow-[inset_2px_0_0_var(--accent)]'

const Affordance = () => (
  <ChevronsUpDown
    size={11}
    aria-hidden
    className="text-fg-subtle ml-auto shrink-0 opacity-0 transition-opacity duration-[var(--dur-1)] ease-[var(--ease-out)] group-hover/edit:opacity-100 group-has-[:focus-visible]/edit:opacity-100"
  />
)

/**
 * A property row that opens a native select on click but renders as plain
 * text with an icon — the control chrome would dominate a narrow sidebar,
 * and these are read far more often than they are changed.
 */
const SelectRow = <T extends string>({
  value,
  options,
  labels,
  icon,
  onChange,
  disabled,
}: {
  value: T
  options: readonly T[]
  labels?: Record<string, string>
  icon: React.ReactNode
  onChange: (v: T) => void
  disabled?: boolean
}) => (
  <div className={EDITABLE}>
    {icon}
    <span className="text-fg text-[0.8125rem]">{labels?.[value] ?? value}</span>
    <Affordance />
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="absolute inset-0 cursor-pointer opacity-0"
      aria-label={labels?.[value] ?? value}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  </div>
)

type OptimisticValues = Partial<Pick<Task, 'status' | 'priority' | 'type' | 'assignee_user_id' | 'assignee'>>

export const Properties = ({
  task,
  project,
  relations = [],
  alsoProjects = [],
  projects = [],
}: {
  task: Task
  project: Project
  relations?: Relation[]
  alsoProjects?: string[]
  projects?: { key: string; title: string }[]
}) => {
  const router = useRouter()
  const request = useMutate()
  const { people } = usePeople()
  const stale = useRenderedClaimStale(task.heartbeat_at)
  const [pendingClose, setPendingClose] = useState<TaskStatus | null>(null)
  // An optimistic overlay, stamped with the version of the task it was applied
  // to. When the refresh lands `updated_at` moves on and the overlay stops
  // matching, so it retires itself without an effect clearing state.
  const [optimistic, setOptimistic] = useState<{ at: string; values: OptimisticValues } | null>(null)

  const shown =
    optimistic && optimistic.at === task.updated_at ? { ...task, ...optimistic.values } : task

  const patch = async (
    body: Record<string, unknown>,
    optimisticValues: OptimisticValues = body as OptimisticValues,
  ) => {
    // Applied before the request so the icon moves on click. On a loaded host
    // the round trip is over a second, and waiting for it reads as a dropped
    // click.
    setOptimistic({ at: task.updated_at, values: optimisticValues })
    const result = await request(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body })
    // Status asks for a resolution before it gets here, but priority and type
    // had no guard at all: any refusal rolled the dropdown back with nothing
    // said, which is indistinguishable from a dropped click.
    if (!result.ok) {
      setOptimistic(null)
      return false
    }
    router.refresh()
    return true
  }

  const onAssignee = (userId: string) => {
    const person = people.find((p) => p.id === userId) ?? null
    void patch({ assignee: userId }, { assignee_user_id: userId, assignee: person })
  }

  const onStatus = (next: TaskStatus) => {
    // Closing needs a resolution, so ask rather than fire a PATCH the API
    // will refuse — otherwise the change appears to silently fail.
    if (isTerminal(next) && !task.resolution) {
      setPendingClose(next)
      return
    }
    void patch({ status: next })
  }

  return (
    <aside
      className="border-border flex shrink-0 flex-row flex-wrap gap-x-5 gap-y-3 border-b px-4 py-3 lg:w-[13.75rem] lg:flex-col lg:gap-5 lg:border-b-0 lg:px-4 lg:py-5"
    >
      <Section title="Properties">
        <SelectRow
          value={shown.status}
          options={TASK_STATUSES}
          labels={STATUS_LABEL}
          icon={<StatusIcon status={shown.status} />}
          onChange={onStatus}
        />
        <SelectRow
          value={shown.priority}
          options={TASK_PRIORITIES}
          icon={<PriorityIcon priority={shown.priority} />}
          onChange={(v: TaskPriority) => void patch({ priority: v })}
        />
      </Section>

      {/* The human who owns the work, editable — distinct from who is
          currently holding it below. Every task has one; there is no empty
          state to draw. */}
      <Section title="Assignee">
        <div className={EDITABLE}>
          <Avatar name={shown.assignee?.name ?? 'Unknown'} size={16} />
          <span className="text-fg text-[0.8125rem]">
            {shown.assignee?.name ?? 'Unknown'}
            {shown.assignee && !shown.assignee.active ? (
              <span className="text-fg-subtle"> (inactive)</span>
            ) : null}
          </span>
          <Affordance />
          <select
            value={shown.assignee_user_id}
            onChange={(e) => onAssignee(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Assignee"
          >
            {/* The current assignee may have gone inactive since — `listPeople`
                only offers active users, so their own option is added back in
                or the select would silently show someone else. */}
            {shown.assignee && !people.some((p) => p.id === shown.assignee_user_id) && (
              <option value={shown.assignee_user_id}>{shown.assignee.name} (inactive)</option>
            )}
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </Section>

      {/* The agent actually holding it right now, which may be nobody even
          though the task is always assigned to someone. */}
      <Section title="Held by">
        <div className="flex h-[1.75rem] items-center gap-2">
          {task.claimed_by ? (
            <>
              <Avatar name={task.claimed_by} size={16} />
              <span
                className={cn(
                  'text-[0.8125rem]',
                  stale ? 'text-fg-subtle' : 'text-fg',
                )}
              >
                {task.claimed_by}
                {stale ? ' · stale' : ''}
              </span>
            </>
          ) : (
            <>
              <span className="border-border-strong size-[1rem] rounded-full border border-dashed" />
              <span className="text-fg-subtle text-[0.8125rem]">Unclaimed</span>
            </>
          )}
        </div>
      </Section>

      <Section title="Type">
        <div className={EDITABLE}>
          <TypePill type={shown.type} />
          <Affordance />
          <select
            value={shown.type}
            onChange={(e) => void patch({ type: e.target.value as TaskType })}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Type"
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </Section>

      {task.labels.length > 0 && (
        <Section title="Labels">
          <div className="flex flex-wrap gap-1.5">
            {task.labels.map((l) => (
              <LabelPill key={l}>{l}</LabelPill>
            ))}
          </div>
        </Section>
      )}

      <DependencyEditor taskRef={`${project.key}-${task.number}`} relations={relations} />

      <div className="hidden lg:block">
      <Section title="Project">
        <span className="text-fg-muted flex h-[1.75rem] min-w-0 items-center gap-2 text-[0.8125rem]">
          <ProjectIcon size={13} projectKey={project.key} />
          <span className="truncate">{project.title}</span>
        </span>
      </Section>
      </div>

      {projects.length > 0 && (
        <div className="hidden lg:block">
          <AlsoIn
            taskRef={`${project.key}-${task.number}`}
            homeKey={project.key}
            alsoProjects={alsoProjects}
            projects={projects}
          />
        </div>
      )}

      {task.external_ref && (
        <Section title="Imported from" className="hidden lg:flex">
          <code className="border-border bg-surface-raised text-fg-muted self-start rounded-md border px-1.5 py-px font-mono text-[0.75rem]">
            {task.external_ref}
          </code>
        </Section>
      )}

      <Section title="Dates" className="hidden lg:flex">
        <dl className="flex flex-col gap-1">
          {(
            [
              ['Created', task.created_at],
              ['Updated', task.updated_at],
              ['Resolved', task.resolved_at],
              ['Due', task.due_date],
            ] as const
          )
            .filter(([, value]) => Boolean(value))
            .map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <dt className="text-fg-subtle text-[0.75rem]">{label}</dt>
                <dd className="text-fg-muted text-[0.75rem] tabular-nums">
                  {label === 'Due' ? shortDateWithYear(value as string) : (
                    <RelativeTime iso={value as string} />
                  )}
                </dd>
              </div>
            ))}
        </dl>
      </Section>

      {/* Frozen at creation — unlike the assignee above, this never changes
          hands and never renames itself when a person does. */}
      <Section title="Created by" className="hidden lg:flex">
        <span className="text-fg-muted flex h-[1.75rem] items-center gap-2 text-[0.8125rem]">
          <Avatar name={task.actor_id} size={16} />
          <span className="min-w-0 truncate">{task.actor_id}</span>
        </span>
      </Section>

      {task.attempt > 1 && (
        <Section title="Attempts" className="hidden lg:flex">
          <span className="text-fg-muted tabular text-[0.8125rem]">
            {task.attempt} claims
            <span className="text-fg-subtle"> — may be thrashing</span>
          </span>
        </Section>
      )}

      {pendingClose && (
        <ResolutionDialog
          taskTitle={task.title}
          status={pendingClose}
          suggestion={task.checkpoint_summary}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (resolution: string, kind, duplicateOf) => {
            const ok = await patch({
              status: pendingClose,
              resolution,
              resolutionKind: kind,
              ...(duplicateOf ? { duplicateOf } : {}),
            })
            setPendingClose(null)
            return ok
          }}
        />
      )}
    </aside>
  )
}
