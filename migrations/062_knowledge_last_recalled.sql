-- ===========================================================================
-- 062: remember when each fact was last recalled, instead of recounting it
--
-- `know --unused` ranks the unused set by when each entry was last recalled
-- EVER, never-recalled first. Computed from 061's knowledge_recall_counts with
-- p_since = '-infinity', that aggregates every search_events row (unnesting
-- returned_slugs) and every knowledge_reads hit on each request, however small
-- the limit: the work grows with all recorded history, not with the answer.
--
-- The one number the ranking needs is kept on the row instead:
--   knowledge.last_recalled_at   the latest search that returned the entry, or
--                                direct hit that read it, whichever is later
-- maintained by two insert triggers on the tables 053 already writes, and
-- backfilled once below. The unused query then reads knowledge alone through
-- one partial index, bounded by its limit.
--
-- Same semantics as knowledge_recall_counts, so the two cannot disagree: a
-- returned slug matches knowledge.slug exactly; a read slug is normalised the
-- way getKnowledge normalises it; misses name no entry and do not count.
-- The session briefing and `cairn recall` still record nothing, so they still
-- do not count.
--
-- The trigger only ever moves the timestamp forward, and the WHERE clause makes
-- a repeat recall of an already-later row a no-op rather than a row rewrite.
-- ===========================================================================

alter table knowledge add column if not exists last_recalled_at timestamptz;

comment on column knowledge.last_recalled_at is
  'Latest search that returned this entry or direct read that fetched it (053 telemetry). Null: never recalled. Maintained by triggers on search_events and knowledge_reads.';

create or replace function knowledge_touch_recalled_from_search() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.returned_slugs is not null and cardinality(new.returned_slugs) > 0 then
    update knowledge
       set last_recalled_at = new.created_at
     where slug = any (new.returned_slugs)
       and (last_recalled_at is null or last_recalled_at < new.created_at);
  end if;
  return null;
end;
$$;

create or replace function knowledge_touch_recalled_from_read() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.hit then
    update knowledge
       set last_recalled_at = new.created_at
     where slug = replace(lower(btrim(new.slug)), '_', '-')
       and (last_recalled_at is null or last_recalled_at < new.created_at);
  end if;
  return null;
end;
$$;

drop trigger if exists knowledge_touch_recalled on search_events;
create trigger knowledge_touch_recalled
  after insert on search_events
  for each row execute function knowledge_touch_recalled_from_search();

drop trigger if exists knowledge_touch_recalled on knowledge_reads;
create trigger knowledge_touch_recalled
  after insert on knowledge_reads
  for each row execute function knowledge_touch_recalled_from_read();

-- One pass over history, once. Rerunnable: it only moves timestamps forward.
update knowledge k
   set last_recalled_at = c.last_recalled
  from knowledge_recall_counts('-infinity'::timestamptz) c
 where c.knowledge_id = k.id
   and c.last_recalled is not null
   and (k.last_recalled_at is null or k.last_recalled_at < c.last_recalled);

-- The unused ranking: current entries, never-recalled first, then oldest recall,
-- then oldest entry. Matches the ORDER BY in unusedKnowledge exactly, so the
-- limit is satisfied from the front of the index.
create index if not exists knowledge_unused_rank_idx
  on knowledge (last_recalled_at asc nulls first, created_at asc, id asc)
  where superseded_by is null;
