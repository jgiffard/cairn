/**
 * Columns the task PATCH handler can write. Migration 086 uses the same list
 * for combined label deltas: adding a route field must keep that SQL in step.
 * Replacement labels are a PATCH field too, but cannot accompany a delta.
 */
export const TASK_PATCH_COLUMNS = [
  'title', 'description', 'type', 'status', 'priority', 'labels', 'due_date', 'resolution_kind',
  'external_ref', 'external_url', 'subject_id', 'assignee_user_id', 'resolution',
  'resolved_at', 'resolved_by', 'parent_id', 'duplicate_of', 'claimed_by',
  'claimed_session', 'claimed_at', 'heartbeat_at',
] as const

export type TaskPatch = Partial<Record<(typeof TASK_PATCH_COLUMNS)[number], unknown>>
