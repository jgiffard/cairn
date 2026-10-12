-- ===========================================================================
-- 083: vitals knows who wrote, not only what they were called
--
-- CAIRN-409. croft's vitals, 2026-10-12:
--
--   claude-code · monty.torr@gmail.com has written nothing in 24h, against
--   2672 in the week before.
--
-- Both runtimes wrote all day, as `claude-code · Cal`. CAIRN-385 had moved
-- nineteen projects from personal, where Cal's account has no display name,
-- to croft, where the same email's account is called Cal. The move kept every
-- actor string as written, so the history and the new writes carry two labels
-- for one person on one runtime. `agent_stats` grouped by the label, so the
-- old one read as silence and the new one had no baseline. The same split
-- happened on Dispofi when a display name was set (CAIRN-303), and it happens
-- whenever someone renames themselves.
--
-- The label is for display. The writer's identity is
-- `task_activity_events.owner_user_id`: since 047 every write stamps the
-- writer's user id there (recordActivity and the claim, release, checkpoint
-- and reaper functions all pass `actor.userId`), and move-projects remaps it
-- by email. So both lists now carry it, as `userId`, and src/lib/api/vitals.ts
-- groups by runtime and user. Each label stays its own row, so "Who wrote"
-- still shows history under the name it was written under. `lastSeenAt` lets
-- the check name the most recent label.
--
-- TRANSFORMED, NOT RE-COPIED, as in 050, 051, 054 and 070. This edits the
-- definitions actually installed, matches the exact text they contain, and
-- raises if it is not there.
-- ===========================================================================

do $migration$
declare
  fn oid;
  definition text;
  updated text;
begin
  -- --- cairn_vitals.agent_stats -------------------------------------------
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cairn_vitals';

  if fn is null then
    raise exception 'cairn_vitals is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%"userId"%' then
    raise notice 'cairn_vitals already carries userId; nothing to do';
  else
    -- 050 left `e.actor_type as "actorType",` as the second column.
    updated := regexp_replace(
      definition,
      '(e\.actor_type[[:space:]]+as "actorType",)',
      E'\\1\n        e.owner_user_id                                              as "userId",' ||
      E'\n        max(e.created_at)                                            as "lastSeenAt",',
      'g'
    );

    updated := regexp_replace(
      updated,
      'group by e\.actor_id, e\.actor_type(?![[:space:]]*,)',
      'group by e.actor_id, e.actor_type, e.owner_user_id',
      'g'
    );

    if updated not like '%"userId"%'
       or updated not like '%"lastSeenAt"%'
       or updated not like '%group by e.actor_id, e.actor_type, e.owner_user_id%' then
      raise exception 'cairn_vitals did not contain the agent_stats shape 050 installed; refusing to guess';
    end if;

    execute updated;
  end if;

  -- --- cairn_vitals_signals.absent_agents ---------------------------------
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cairn_vitals_signals';

  if fn is null then
    raise exception 'cairn_vitals_signals is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%''userId''%' then
    raise notice 'cairn_vitals_signals already carries userId; nothing to do';
    return;
  end if;

  updated := replace(
    definition,
    $$jsonb_build_object('agent', a.agent, 'lastSeenAt', a.last_seen)$$,
    $$jsonb_build_object('agent', a.agent, 'userId', a.user_id, 'lastSeenAt', a.last_seen)$$
  );

  updated := replace(
    updated,
    'select e.actor_id as agent, max(e.created_at) as last_seen',
    'select e.actor_id as agent, e.owner_user_id as user_id, max(e.created_at) as last_seen'
  );

  updated := replace(
    updated,
    E'      group by e.actor_id\n      having max(e.created_at) < min(b.baseline_start)',
    E'      group by e.actor_id, e.owner_user_id\n      having max(e.created_at) < min(b.baseline_start)'
  );

  if updated not like '%''userId'', a.user_id%'
     or updated not like '%e.owner_user_id as user_id%'
     or updated not like '%group by e.actor_id, e.owner_user_id%' then
    raise exception 'cairn_vitals_signals did not contain the absent_agents shape 065 installed; refusing to guess';
  end if;

  execute updated;
end
$migration$;
