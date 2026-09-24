-- Omitted fields arrive as NULL (or empty collections) in the existing session
-- upsert. Preserve the last checkpoint's content when a sparse end arrives.
-- 058 is already applied on some installations; replace its trigger function
-- rather than editing that migration in place.
create or replace function guard_session_no_reopen() returns trigger
language plpgsql as $$
begin
  if old.ended_at is not null and new.ended_at is null then
    raise exception 'Session already ended; cannot checkpoint.' using errcode = 'PZ001';
  end if;

  new.request := coalesce(new.request, old.request);
  new.learned := coalesce(new.learned, old.learned);
  new.completed := coalesce(new.completed, old.completed);
  new.next_steps := coalesce(new.next_steps, old.next_steps);
  new.project_id := coalesce(new.project_id, old.project_id);
  new.cwd := coalesce(new.cwd, old.cwd);
  new.started_at := coalesce(new.started_at, old.started_at);
  new.files := case when new.files = '[]'::jsonb then old.files else new.files end;
  new.task_refs := case when new.task_refs = '{}'::text[] then old.task_refs else new.task_refs end;
  new.tool_calls := coalesce(new.tool_calls, old.tool_calls);
  new.scheduled := old.scheduled or new.scheduled;
  return new;
end;
$$;
