-- A late in-progress checkpoint must never turn a finished session back into a
-- live one. Enforce at the row boundary: a pre-read alone races with session end.
-- Existing session-end replays (closed -> closed) retain their upsert semantics.
create or replace function guard_session_no_reopen() returns trigger
language plpgsql as $$
begin
  if old.ended_at is not null and new.ended_at is null then
    raise exception 'Session already ended; cannot checkpoint.' using errcode = 'PZ001';
  end if;
  return new;
end;
$$;

create trigger sessions_no_reopen before update on sessions
  for each row execute function guard_session_no_reopen();

comment on table sessions is
  'One row per agent session, checkpointed while ongoing and completed at session end. Idempotent on (platform_source, external_id).';
