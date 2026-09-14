-- ===========================================================================
-- 039: closing because you checked is not the same as closing because you fixed
--
-- Reported from a real backlog triage: six tasks were closed, and not one was
-- the reporter's own work. Each was closed because they READ THE CURRENT CODE
-- and found the defect already fixed by somebody else's commit. The value
-- delivered was the verification, not a change.
--
-- All six recorded `fixed`, which is the only kind that fits and is untrue —
-- it claims authorship of work someone else did. Worse, it makes those closes
-- indistinguishable from a task somebody shut without reading anything, which
-- is precisely the distinction a memory store exists to keep.
--
-- `verified` says what happened: the fix was already there, and this is the
-- evidence that somebody looked.
-- ===========================================================================

alter table tasks drop constraint if exists tasks_resolution_kind_check;

alter table tasks
  add constraint tasks_resolution_kind_check
  check (resolution_kind is null or resolution_kind in
    ('fixed', 'verified', 'wont-fix', 'duplicate', 'not-reproducible', 'superseded', 'answered'));

comment on column tasks.resolution_kind is
  'How it ended. `fixed` claims the change; `verified` says the fix was already '
  'present and this close is the record that somebody checked.';
