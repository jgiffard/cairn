-- 022: structured delivery evidence in the task activity stream

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'resolved', 'resolution_revised', 'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    'git_commit', 'git_push', 'run_result'
  ));

comment on column task_activity_events.data is
  'Event payload. Delivery evidence uses git_commit, git_push, or run_result.';
