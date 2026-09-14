-- ===========================================================================
-- 040: the timeline can outlive the task, and can hold what is not a task
--
-- Two gaps with one cause: every activity row must belong to a live task.
--
-- 1. Deleting a task cascades its events away, so the timeline loses not only
--    the task but every trace it ever existed. A guarded delete makes that
--    hard to do by accident; it does not make the erasure honest.
-- 2. A project being created, renamed, archived or deleted is real activity
--    with no task to hang from, so none of it was recorded anywhere.
--
-- task_id becomes nullable and detaches instead of cascading, project_id is
-- recorded alongside it, and the ref is copied into `data` before a delete —
-- so a tombstone still says what it was about after the row it pointed at is
-- gone. An event with neither is possible and meaningful: knowledge deleted.
-- ===========================================================================

alter table task_activity_events
  alter column task_id drop not null;

alter table task_activity_events
  drop constraint if exists task_activity_events_task_id_fkey;

alter table task_activity_events
  add constraint task_activity_events_task_id_fkey
  foreign key (task_id) references tasks (id) on delete set null;

alter table task_activity_events
  add column if not exists project_id uuid references projects (id) on delete set null;

-- Every existing row belongs to a task, so its project is knowable now and
-- would not be after a future delete.
update task_activity_events e
   set project_id = t.project_id
  from tasks t
 where t.id = e.task_id and e.project_id is null;

-- Ownership, stated rather than inferred through two joins.
--
-- Every read of this table reached the owner via task -> project. A tombstone
-- has no task, and a deleted knowledge entry has no project either, so those
-- rows would be unreachable — present in the table and invisible to every
-- query that is allowed to see them.
alter table task_activity_events
  add column if not exists owner_user_id uuid references app_users (id) on delete cascade;

update task_activity_events e
   set owner_user_id = p.owner_user_id
  from tasks t
  join projects p on p.id = t.project_id
 where t.id = e.task_id and e.owner_user_id is null;

create index if not exists task_activity_events_owner_idx
  on task_activity_events (owner_user_id, created_at desc);

create index if not exists task_activity_events_project_idx
  on task_activity_events (project_id, created_at desc)
  where project_id is not null;

-- Derived from what the code emits, and dropped before it is added so that
-- re-running is not an error. The lesson from 032, which failed the deploy by
-- listing events from memory rather than from the source.
alter table task_activity_events
  drop constraint if exists task_activity_events_event_check;

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    -- written by diffTaskEvents
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'resolved', 'resolution_revised', 'resolution_withdrawn',
    'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    -- delivery evidence
    'git_commit', 'git_push', 'run_result',
    -- work that left no trace until now
    'checkpointed', 'attachment_added', 'attachment_removed',
    'dependency_added', 'dependency_removed',
    -- things that are not a task
    'project_created', 'project_renamed', 'project_key_changed',
    'project_archived', 'project_restored', 'project_deleted',
    -- tombstones: the row they described is gone, the record is not
    'task_deleted', 'knowledge_deleted'
  ));

comment on column task_activity_events.task_id is
  'Null once the task is deleted: the event detaches rather than cascading, so '
  'the timeline keeps the record. `data` carries the ref it referred to.';
