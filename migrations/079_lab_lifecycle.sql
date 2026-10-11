-- ===========================================================================
-- 079: the Lab lifecycle (CAIRN-384)
--
-- Two things, both idempotent:
--
-- 1. An `under construction` stage, first on the board: the write-up is still
--    being written, so the subject is not yet `to explore`. It is seeded only
--    where the stages are still exactly the nine 071 seeded, untouched (same
--    names, categories, colours and positions). An instance whose stages were
--    curated, renamed, reordered or added to is left alone: its administrator
--    adds the stage through the API (docs/lab.md). A second run finds ten
--    stages, not nine, and does nothing.
--
-- 2. `subject_promoted` joins the allowed activity event kinds, for
--    POST /subjects/{ref}/promote. The list is rebuilt from 077's, which is the
--    latest definition: copying an older file would silently drop kinds.
--    NOT VALID, as in 071 and 077: adding a validated check scans the table
--    under ACCESS EXCLUSIVE and the runner holds that lock to the end of this
--    file's transaction. 080 validates it in its own transaction.
-- ===========================================================================

do $$
declare
  v_untouched boolean;
begin
  if exists (select 1 from lab_stages where lower(name) = 'under construction') then
    return;
  end if;

  select (select count(*) from lab_stages) = 9
     and (
       select count(*)
         from lab_stages s
         join (values
           ('to explore',        'planned',   '#8a8792', 0),
           ('exploring',         'active',    '#6b7fa6', 1),
           ('done',              'completed', '#5f8a63', 2),
           ('rejected',          'dropped',   '#a0685f', 3),
           ('to implement',      'planned',   '#8f8a74', 4),
           ('implementing',      'active',    '#a88a4e', 5),
           ('internal testing',  'active',    '#86709e', 6),
           ('ready for rollout', 'active',    '#4f8c86', 7),
           ('rolled out',        'completed', '#4e7f5a', 8)
         ) d (name, category, color, position)
           on lower(s.name) = d.name
          and s.category = d.category
          and s.color = d.color
          and s.position = d.position
     ) = 9
    into v_untouched;

  if not v_untouched then
    return;
  end if;

  update lab_stages set position = position + 1;
  insert into lab_stages (name, category, color, position)
  values ('under construction', 'planned', '#7d8590', 0)
  on conflict do nothing;
end
$$;

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
    'subject_promoted'
  )) not valid;
