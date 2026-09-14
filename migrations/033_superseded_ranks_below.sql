-- ===========================================================================
-- 033: a correction outranks the claim it corrects
--
-- `superseded_by` is how this store says "that is no longer true", and the
-- column comment on it has claimed since 013 that superseded rows "stay
-- findable but are ranked below and marked". They were marked. They were never
-- ranked below: the ordering sorts on widened, rank, answered and kind, and
-- consults `superseded_by` nowhere.
--
-- So a stale fact whose wording matched a query better than its replacement's
-- came back first, which is precisely the failure the mechanism exists to
-- prevent — two contradictory claims, equally findable, the wrong one on top.
--
-- Only the ORDER BY changes. The function is otherwise 020 verbatim.
-- ===========================================================================

create or replace function search_all(
  p_owner       uuid,
  p_query       text,
  p_terms       text[] default null,
  p_project     text default null,
  p_kinds       text[] default null,
  p_limit       int  default 20,
  p_min_precise int  default 3
)
returns table (
  kind         text,
  id           uuid,
  ref          text,
  title        text,
  subtitle     text,
  project_key  text,
  status       text,
  type         text,
  answered     boolean,
  updated_at   timestamptz,
  body_bytes   int,
  rank         real,
  widened      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with
  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end as wide
  ),
  want as (
    select p_kinds is null as all_kinds, coalesce(p_kinds, '{}'::text[]) as kinds
  ),

  task_rows as (
    select 'task'::text as kind, t.id,
           p.key || '-' || t.number as ref,
           t.title,
           nullif(concat_ws(' · ', t.priority, nullif(array_to_string(t.labels, ', '), '')), '') as subtitle,
           p.key as project_key, t.status, t.type,
           t.has_resolution as answered, t.updated_at,
           (coalesce(length(t.description), 0) + coalesce(length(t.resolution), 0))::int as body_bytes,
           t.search_vector as vec
    from tasks t
    join projects p on p.id = t.project_id
    cross join want w
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'task' = any (w.kinds))
  ),

  note_rows as (
    select 'note'::text as kind, n.id,
           p.key || '-' || t.number as ref,
           left(regexp_replace(n.note, '\s+', ' ', 'g'), 120) as title,
           n.kind as subtitle,
           p.key as project_key, t.status, t.type,
           (n.kind in ('finding', 'decision')) as answered,
           n.created_at as updated_at,
           coalesce(length(n.note), 0)::int as body_bytes,
           to_tsvector('english'::regconfig, coalesce(n.note, '')) as vec
    from task_notes n
    join tasks t    on t.id = n.task_id
    join projects p on p.id = t.project_id
    cross join want w
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))
  ),

  knowledge_rows as (
    select 'knowledge'::text as kind, k.id,
           k.slug as ref,
           k.title,
           nullif(array_to_string(k.labels, ', '), '') as subtitle,
           -- Projects are narrower, so they win; entities only when there are
           -- none. Reporting neither is what made an entity-scoped fact look
           -- global to every caller.
           coalesce(
             (select string_agg(pr.key, ',' order by pr.key)
                from knowledge_projects kp
                join projects pr on pr.id = kp.project_id
               where kp.knowledge_id = k.id),
             (select string_agg(e.key, ',' order by e.key)
                from knowledge_entities ke
                join entities e on e.id = ke.entity_id
               where ke.knowledge_id = k.id)
           ) as project_key,
           case when k.superseded_by is not null then 'superseded' else 'current' end as status,
           'knowledge'::text as type,
           (k.verified_at is not null) as answered,
           k.updated_at,
           coalesce(length(k.body), 0)::int as body_bytes,
           k.search_vector as vec
    from knowledge k
    cross join want w
    where k.owner_user_id = p_owner
      and (w.all_kinds or 'knowledge' = any (w.kinds))
  ),

  session_rows as (
    select 'session'::text as kind, s.id,
           to_char(coalesce(s.ended_at, s.created_at), 'YYYY-MM-DD') as ref,
           coalesce(s.request, s.completed, '(session)') as title,
           nullif(concat_ws(' · ', s.platform_source, s.cwd), '') as subtitle,
           p.key as project_key,
           s.platform_source as status,
           'session'::text as type,
           (s.next_steps is not null) as answered,
           coalesce(s.ended_at, s.created_at) as updated_at,
           (coalesce(length(s.learned), 0) + coalesce(length(s.completed), 0)
            + coalesce(length(s.next_steps), 0))::int as body_bytes,
           s.search_vector as vec
    from sessions s
    left join projects p on p.id = s.project_id
    cross join want w
    where s.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'session' = any (w.kinds))
  ),

  candidates as (
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows
  ),

  precise as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.precise) as rank, false as widened
    from candidates c, q
    where c.vec @@ q.precise
    order by ts_rank(c.vec, q.precise) desc
    limit p_limit
  ),

  wide as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.wide) as rank, true as widened
    from candidates c, q
    where q.wide is not null
      and (select count(*) from precise) < p_min_precise
      and c.vec @@ q.wide
      and c.id not in (select precise.id from precise)
    order by ts_rank(c.vec, q.wide) desc
    limit p_limit * 2
  )

  select * from (select * from precise union all select * from wide) hits
  order by
    hits.widened asc,
    -- A correction beats the claim it corrects.
    --
    -- Superseded knowledge was marked and nothing more, so a stale entry whose
    -- wording happened to match the query better still came back above the
    -- entry that replaced it — the schema comment promised "ranked below" and
    -- the ordering never consulted the column.
    --
    -- A demotion rather than a hard sink: sorting every superseded row beneath
    -- every current one would bury the only relevant answer under ten
    -- irrelevant tasks, and "findable but marked" is the whole point of
    -- keeping it. 0.4 puts it behind anything comparable while leaving it
    -- above rows that barely match at all.
    (hits.rank * case when hits.status = 'superseded' then 0.4 else 1 end)::real desc,
    hits.answered desc,
    case hits.kind when 'task' then 0 when 'knowledge' then 1
                   when 'note' then 2 else 3 end,
    hits.updated_at desc
  limit p_limit;
$$;

revoke all on function search_all from public;

-- The comment this migration was written to make true. Stated as what the
-- ordering actually does, rather than as an intention: "ranked below" read as
-- an absolute, and the demotion is relative to comparable hits.
comment on column knowledge.superseded_by is
  'Points at what replaced this. Superseded rows stay findable and are marked, '
  'and their search rank is demoted so the correction outranks the claim it '
  'corrects wherever both match.';
