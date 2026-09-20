-- ===========================================================================
-- 050: vitals can tell a person from a runtime
--
-- The warning, seen on our own instance:
--
--   monty.torr@gmail.com has written nothing in 24h, against 97 in the week
--   before. This may simply be an idle runtime; verify it was expected to be
--   active before investigating hooks or keys.
--
-- That is the owner of the instance. The 97 is a week of his own clicks in
-- the web UI. He has no hooks and no keys to investigate.
--
-- Not a legacy multi-user artefact, which was the first guess. It is a live
-- and correct distinction that the check never looked at: `actorLabel` in
-- src/lib/api/actor.ts gives a human their display name unqualified and an
-- agent `<runtime> · <display name>`, and 049 says so outright while
-- backfilling older rows. The four actors on that instance:
--
--   claude-code · monty.torr@gmail.com   recent 208   week 1641
--   openclaw · monty.torr@gmail.com      recent   0   week 1045
--   monty.torr@gmail.com                 recent   0   week   97   <- a person
--   codex · monty.torr@gmail.com         recent   0   week   74
--
-- `agent_stats` selected `e.actor_id as agent` and grouped by it, with no
-- reference to `actor_type` — a column that has existed since 001_initial.
-- So every person who ever touched a task arrived in the list that the
-- agent-silent check reads.
--
-- THE COST IS NOT THE NOISE. openclaw wrote 1045 times in the week and
-- nothing in 24h, and that is exactly what the check exists to surface. It
-- was sitting in the same list as a false positive about a person, and a
-- warning that is wrong half the time is one nobody finishes reading.
--
-- Only the agent_stats CTE and one line of assess() change. Otherwise 036
-- verbatim.
-- ===========================================================================

create or replace function cairn_vitals(p_owner uuid, p_hours int default 24)
returns jsonb
language sql
stable
as $$
with
  bounds as (
    select
      now() - make_interval(hours => p_hours)     as window_start,
      -- The week before the window, as the thing to compare against. A count
      -- means nothing on its own; "none today, forty last week" means a lot.
      now() - make_interval(hours => p_hours + 168) as baseline_start,
      now() - make_interval(hours => p_hours)     as baseline_end
  ),
  own_tasks as (
    select t.* from tasks t
    join projects p on p.id = t.project_id
    where p.owner_user_id = p_owner
  ),
  session_stats as (
    select
      count(*) filter (where s.created_at >= b.window_start)                      as recent,
      count(*) filter (where s.created_at >= b.window_start
                         and jsonb_typeof(s.files) = 'array'
                         and jsonb_array_length(s.files) > 0)                     as recent_with_files,
      -- The prose half. A session is the files AND what was learned; the
      -- second costs a model call and can stop being written without anything
      -- failing, because the hook keeps the row when it cannot reach one.
      count(*) filter (where s.created_at >= b.window_start
                         and (coalesce(s.learned, '') <> ''
                           or coalesce(s.completed, '') <> ''
                           or coalesce(s.next_steps, '') <> ''))                  as recent_summarised,
      count(*) filter (where s.created_at >= b.baseline_start
                         and s.created_at < b.baseline_end)                       as baseline,
      count(*) filter (where s.created_at >= b.baseline_start
                         and s.created_at < b.baseline_end
                         and jsonb_typeof(s.files) = 'array'
                         and jsonb_array_length(s.files) > 0)                     as baseline_with_files
    from sessions s, bounds b
    where s.owner_user_id = p_owner
  ),
  task_stats as (
    select
      count(*) filter (where t.created_at >= b.window_start)                      as opened,
      count(*) filter (where t.resolved_at >= b.window_start)                     as closed,
      count(*) filter (where t.status = 'doing' and t.claimed_by is null
                         and coalesce(t.heartbeat_at, t.updated_at) < b.window_start) as stalled,
      count(*) filter (where t.claimed_by is not null)                            as held
    from own_tasks t, bounds b
  ),
  release_stats as (
    select count(*) as auto_released
    from task_activity_events e
    join own_tasks t on t.id = e.task_id, bounds b
    where e.event = 'released'
      and e.data->>'reason' = 'reconcile'
      and e.created_at >= b.window_start
  ),
  knowledge_stats as (
    select count(*) as written
    from knowledge k, bounds b
    where k.owner_user_id = p_owner and k.created_at >= b.window_start
  ),
  -- Per agent, because an agent that has gone silent is the single clearest
  -- sign that its wiring broke, and it is invisible in any total.
  agent_stats as (
    select coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.agent), '[]'::jsonb) as agents
    from (
      select
        e.actor_id                                                   as agent,
        -- Carried, not filtered on. The panel these rows feed is titled
        -- "Who wrote", and a person who wrote ninety-seven times in a week
        -- is a true answer to that question. It is the agent-silent check
        -- that needed to know the difference, not this list.
        e.actor_type                                                 as "actorType",
        count(*) filter (where e.created_at >= b.window_start)        as recent,
        count(*) filter (where e.created_at >= b.baseline_start
                           and e.created_at < b.baseline_end)         as baseline
      from task_activity_events e
      join own_tasks t on t.id = e.task_id, bounds b
      where e.created_at >= b.baseline_start
      -- Grouped by both, so a person and a runtime that somehow shared an
      -- actor_id stay two rows rather than one row of nonsense.
      group by e.actor_id, e.actor_type
    ) a
  )
select jsonb_build_object(
  'windowHours', p_hours,
  'sessions', jsonb_build_object(
    'recent', s.recent,
    'recentWithFiles', s.recent_with_files,
    'recentSummarised', s.recent_summarised,
    'baseline', s.baseline,
    'baselineWithFiles', s.baseline_with_files
  ),
  'tasks', jsonb_build_object(
    'opened', t.opened, 'closed', t.closed, 'stalled', t.stalled, 'held', t.held
  ),
  'autoReleased', r.auto_released,
  'knowledgeWritten', k.written,
  'agents', a.agents
)
from session_stats s, task_stats t, release_stats r, knowledge_stats k, agent_stats a;
$$;
