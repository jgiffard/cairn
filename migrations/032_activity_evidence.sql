-- ===========================================================================
-- Structured delivery evidence in the task activity stream: git_commit,
-- git_push and run_result, so what an agent actually shipped is recorded as
-- events rather than asserted in prose.
--
-- Numbered 032, not 022. It arrived as 022_activity_evidence.sql beside the
-- existing 022_vitals.sql, which sorts AFTER it — so a migration written today
-- would have run before one applied two days ago. The ledger records filenames,
-- so it would still have been applied and nothing would have complained; the
-- ordering guarantee would simply have stopped being true.
--
-- The constraint is also written differently from the original. As sent it was
-- a bare `add constraint`, which failed the deploy outright:
--
--   check constraint "task_activity_events_event_check" of relation
--   "task_activity_events" is violated by some row
--
-- `resolution_withdrawn` was missing from the list. It is emitted whenever a
-- task is reopened — the event that clears a resolution rather than replacing
-- it — and production already held rows carrying it. Two failures in one: the
-- migration could not apply, and had it applied, the next reopen would have
-- been rejected by the database in normal use.
--
-- So the list is derived from what the code actually emits, and the constraint
-- is dropped before it is added, so re-running this is not an error.
-- ===========================================================================

alter table task_activity_events
  drop constraint if exists task_activity_events_event_check;

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    -- Written by diffTaskEvents in src/lib/api/activity.ts
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'resolved', 'resolution_revised', 'resolution_withdrawn',
    'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    -- Delivery evidence
    'git_commit', 'git_push', 'run_result'
  ));

comment on column task_activity_events.data is
  'Event payload. Delivery evidence uses git_commit, git_push, or run_result.';
