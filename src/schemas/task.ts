import { z } from 'zod'

/**
 * Single source of truth for Cairn's domain vocabulary.
 *
 * The API, the CLI, the OpenAPI spec and the UI all import from here, so a new
 * task type is added in exactly one place — plus a one-line migration to widen
 * the matching CHECK constraint.
 */

export const TASK_TYPES = ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs'] as const

/** Board order. The UI renders columns in this sequence. */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'doing',
  'in-review',
  'done',
  'cancelled',
] as const

/** Statuses that require a resolution before the API will accept the transition. */
export const TERMINAL_STATUSES = ['done', 'cancelled'] as const

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const

export const RESOLUTION_KINDS = [
  'fixed',
  'wont-fix',
  'duplicate',
  'not-reproducible',
  'superseded',
  'answered',
] as const

export const NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff'] as const

export const ACTOR_TYPES = ['human', 'agent'] as const

export const taskType = z.enum(TASK_TYPES)
export const taskStatus = z.enum(TASK_STATUSES)
export const taskPriority = z.enum(TASK_PRIORITIES)
export const resolutionKind = z.enum(RESOLUTION_KINDS)
export const noteKind = z.enum(NOTE_KINDS)

export type TaskType = z.infer<typeof taskType>
export type TaskStatus = z.infer<typeof taskStatus>
export type TaskPriority = z.infer<typeof taskPriority>
export type ResolutionKind = z.infer<typeof resolutionKind>
export type NoteKind = z.infer<typeof noteKind>

export const isTerminal = (s: TaskStatus): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(s)

/**
 * Field definitions WITHOUT defaults.
 *
 * This split is load-bearing. `.default()` survives `.partial()` — Zod's
 * ZodOptional wraps the ZodDefault rather than replacing it, so
 * `createTaskSchema.partial().parse({})` yields `{ type: 'feature' }`. Deriving
 * the PATCH schema that way made every update silently reset `type` and
 * `priority` to their defaults, quietly corrupting rows the caller never
 * mentioned. Defaults belong on the create schema only.
 */
const taskFields = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(100_000),
  type: taskType,
  status: taskStatus,
  priority: taskPriority,
  labels: z.array(z.string().min(1).max(50)).max(20),
  dueDate: z.string().date(),
})

export const createTaskSchema = taskFields.partial().extend({
  title: z.string().min(1).max(300),
  type: taskType.default('feature'),
  status: taskStatus.default('backlog'),
  priority: taskPriority.default('medium'),
  labels: z.array(z.string().min(1).max(50)).max(20).default([]),
  /** File it under an existing task. A ref (`CAI-42`) or uuid. */
  parentRef: z.string().min(2).max(60).optional(),
})

/** Partial update. No defaults, so absent fields stay absent. */
export const updateTaskSchema = taskFields.partial().extend({
  resolution: z.string().max(100_000).optional(),
  resolutionKind: resolutionKind.optional(),
  /**
   * The task this one duplicates, as a ref or uuid. Only meaningful alongside
   * `resolutionKind: 'duplicate'`; the database refuses the pair otherwise.
   * `null` clears it.
   */
  duplicateOf: z.string().min(2).max(60).nullable().optional(),
  /** Re-parent, or `null` to lift it back to the top level. */
  parentRef: z.string().min(2).max(60).nullable().optional(),
  /**
   * Move the task to another project, by key or uuid. Per-project numbering
   * means the ref changes, so this is handled apart from the field updates.
   */
  project: z.string().min(1).max(60).optional(),
  /**
   * Additional projects this task also belongs to, by key. Replaces the set;
   * `[]` or `null` clears it. The home project is not one of these -- it keeps
   * the ref, and these only widen where the task appears.
   */
  alsoProjects: z.array(z.string().min(1).max(10)).max(20).nullable().optional(),
})

export const createNoteSchema = z.object({
  note: z.string().min(1).max(100_000),
  kind: noteKind.default('note'),
  facts: z.array(z.string().min(1).max(500)).max(50).optional(),
})

export const ACTIVITY_EVIDENCE_EVENTS = ['git_commit', 'git_push', 'run_result'] as const
export const activityEvidenceEvent = z.enum(ACTIVITY_EVIDENCE_EVENTS)

/** Structured delivery evidence agents can attach to a task timeline. */
export const createActivityEvidenceSchema = z.object({
  event: activityEvidenceEvent,
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  repo: z.string().min(1).max(300).optional(),
  branch: z.string().min(1).max(250).optional(),
  message: z.string().max(500).optional(),
  url: z.string().url().max(2_000).optional(),
  remote: z.string().min(1).max(250).optional(),
  command: z.string().min(1).max(2_000).optional(),
  status: z.enum(['passed', 'failed', 'skipped']).optional(),
  exitCode: z.number().int().min(-255).max(255).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  output: z.string().max(50_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/** `CAI-42` — the identifier agents actually use in prose. */
export const taskRefSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/, 'expected a task ref like CAI-42')

export const parseTaskRef = (ref: string): { key: string; number: number } => {
  const parsed = taskRefSchema.parse(ref)
  const idx = parsed.lastIndexOf('-')
  return { key: parsed.slice(0, idx), number: Number(parsed.slice(idx + 1)) }
}
