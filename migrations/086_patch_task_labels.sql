-- Atomic label deltas. The row lock gives both the update and its activity
-- snapshot the latest committed labels, including when callers race.
create or replace function patch_task_labels(
  p_task uuid,
  p_add text[],
  p_remove text[],
  p_patch jsonb default '{}'::jsonb,
  p_owner uuid default null,
  p_project uuid default null,
  p_also_projects uuid[] default null
) returns jsonb language plpgsql as $$
declare
  before_row tasks%rowtype;
  after_row tasks%rowtype;
  assignments text;
  changed_ref record;
  summary jsonb;
  moved jsonb := null;
begin
  select * into before_row from tasks where id = p_task for update;
  if not found then return null; end if;

  if exists (select 1 from unnest(p_add || p_remove) n where length(n) not between 1 and 50 or n is null)
     or coalesce(cardinality(p_add), 0) + coalesce(cardinality(p_remove), 0) = 0
     or p_add && p_remove then
    raise exception using errcode = '23514', message = 'labelPatch needs valid, non-overlapping add/remove names.';
  end if;

  -- Replacement and delta semantics cannot be mixed, including by an RPC
  -- caller bypassing the route schema. The allowlist still names every PATCH
  -- column, so its drift guard can compare the whole route contract.
  if p_patch ? 'labels' then
    raise exception using errcode = '23514', message = 'labels and labelPatch cannot be combined.';
  end if;

  -- Only field columns accepted by PATCH may be supplied. Column names are
  -- allowlisted and quoted; values use bound JSON and the table's own types.
  if exists (
    select 1 from jsonb_object_keys(p_patch) k where k <> all(array[
      'title','description','type','status','priority','labels','due_date','resolution_kind',
      'external_ref','external_url','subject_id','assignee_user_id','resolution',
      'resolved_at','resolved_by','parent_id','duplicate_of','claimed_by',
      'claimed_session','claimed_at','heartbeat_at'
    ])
  ) then
    raise exception using errcode = '23514', message = 'Unsupported task patch field.';
  end if;
  select string_agg(format('%I = (jsonb_populate_record(null::tasks, $4)).%I', k, k), ', ')
    into assignments from jsonb_object_keys(p_patch) k;

  -- One UPDATE derives labels from the stored row, preserving first occurrence
  -- order and appending only new names. Other fields participate in this write.
  execute 'update tasks t set ' || coalesce(assignments || ', ', '') || '
    labels = array(
      select name from unnest(t.labels || $2) with ordinality as names(name, pos)
      where not (name = any($3)) group by name order by min(pos)
    ) where t.id = $1 returning t.*'
    into after_row using p_task, p_add, p_remove, p_patch;

  if cardinality(after_row.labels) > 20 then
    raise exception using errcode = '23514', message = 'labelPatch would exceed the maximum of 20 labels.';
  end if;

  -- Include secondary writes in this transaction: a refusal must not leave a
  -- moved task or changed links behind. Reuse the current move implementation.
  if p_project is not null then
    select * into changed_ref from move_task(p_owner, p_task, p_project);
    moved := jsonb_build_object('ref', changed_ref.project_key || '-' || changed_ref.number);
    select * into after_row from tasks where id = p_task;
  end if;
  if p_also_projects is not null then
    delete from task_projects where task_id = p_task;
    insert into task_projects(task_id, project_id)
      select p_task, unnest(p_also_projects);
  end if;

  select jsonb_build_object(
    'added', coalesce(jsonb_agg(name order by pos) filter (where side = 'add' and not present), '[]'::jsonb),
    'removed', coalesce(jsonb_agg(name order by pos) filter (where side = 'remove' and present), '[]'::jsonb),
    'alreadyPresent', coalesce(jsonb_agg(name order by pos) filter (where side = 'add' and present), '[]'::jsonb),
    'alreadyAbsent', coalesce(jsonb_agg(name order by pos) filter (where side = 'remove' and not present), '[]'::jsonb)
  ) into summary
  from (
    select name, side, min(pos) as pos, name = any(before_row.labels) as present
    from (
      select name, pos, 'add' as side from unnest(p_add) with ordinality a(name, pos)
      union all
      select name, pos, 'remove' as side from unnest(p_remove) with ordinality r(name, pos)
    ) requested
    group by name, side
  ) names;
  return jsonb_build_object('before', to_jsonb(before_row), 'after', to_jsonb(after_row), 'labelPatch', summary,
    'moved', moved);
end;
$$;
