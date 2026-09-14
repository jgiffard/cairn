-- ===========================================================================
-- 035: whether a run was scheduled is a fact, not a guess about its prose
--
-- The sessions page decided "this was a cron run" by testing the recorded
-- request against a pattern — `[cron:<uuid> …]`, a raw context blob, the
-- contents of an instruction file. That worked until the hook was taught to
-- stop recording those as the request, because they made every headline
-- unreadable. Both changes were right on their own, and together they removed
-- the evidence and then asked the question it answered: the request is null,
-- the pattern matches nothing, and nineteen scheduled runs came back as
-- ordinary sessions headed "No request recorded."
--
-- So it is recorded at write time by the side that knows. The display keeps
-- the text test as a fallback, for the rows written before this column
-- existed and still carrying their preamble.
-- ===========================================================================

alter table sessions
  add column if not exists scheduled boolean not null default false;

-- The rows that still hold their preamble can be classified from it, which is
-- the last time that inference is trustworthy: these are exactly the rows
-- where the evidence was never thrown away.
update sessions
   set scheduled = true
 where scheduled = false
   and request ~* '^(\[cron:[0-9a-f-]{8,}|Conversation info:|#+\s*AGENTS\.md|<INSTRUCTIONS>)';

comment on column sessions.scheduled is
  'The run was started by a schedule rather than a person. Set by the hook, '
  'which sees the prompt even when it declines to record it as the request.';

create index if not exists sessions_scheduled_idx
  on sessions (owner_user_id, scheduled, started_at desc);
