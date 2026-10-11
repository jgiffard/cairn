-- ===========================================================================
-- 081: a comment's author may edit it (CAIRN-391)
--
-- Two things, both idempotent:
--
-- 1. task_comments.edited_at, null until the author edits the comment. A
--    nullable column with no default is a catalogue change: no table rewrite.
--
-- 2. `comment_edited` joins the allowed activity event kinds, for
--    PATCH /tasks/{ref}/comments/{id}. The list is rebuilt from 079's, which is
--    the latest definition: copying an older file would silently drop kinds.
--    NOT VALID, as in 071, 077 and 079: adding a validated check scans the
--    table under ACCESS EXCLUSIVE and the runner holds that lock to the end of
--    this file's transaction. 082 validates it in its own transaction.
-- ===========================================================================

alter table task_comments
  add column if not exists edited_at timestamptz;

alter table task_activity_events
  drop constraint if exists task_activity_events_event_check;

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'assignee_changed',
    'resolved', 'resolution_revised', 'resolution_withdrawn',
    'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    'git_commit', 'git_push', 'run_result',
    'checkpointed', 'auto_checkpointed', 'attachment_added', 'attachment_removed',
    'dependency_added', 'dependency_removed',
    'project_created', 'project_renamed', 'project_key_changed',
    'project_archived', 'project_restored', 'project_deleted',
    'project_described',
    'task_deleted', 'knowledge_deleted',
    'subject_created', 'subject_stage_changed', 'subject_archived', 'subject_restored',
    'subject_deleted', 'handed_off', 'handoff_taken_back',
    'subject_promoted',
    'comment_edited'
  )) not valid;
