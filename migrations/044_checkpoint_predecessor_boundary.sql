-- Preserve the checkpoint predecessor boundary for databases that already
-- applied migration 043 before the stricter existing-claim rule was added.
drop function if exists checkpoint_task_atomic(uuid, uuid, text, text, text, jsonb, uuid, timestamptz, bigint);

create or replace function checkpoint_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_summary text,
  p_payload jsonb,
  p_mutation_id uuid,
  p_queued_at timestamptz,
  p_expected_version bigint default null,
  p_expected_checkpoint_version bigint default null
) returns jsonb language plpgsql as $$
declare
  current_row tasks%rowtype;
  claimed_now boolean := false;
begin
  select t.* into current_row
    from tasks t join projects p on p.id = t.project_id
   where t.id = p_task_id and p.owner_user_id = p_owner_user_id
   for update of t;
  if not found then return jsonb_build_object('code', 'not_found'); end if;

  if current_row.checkpoint_mutation_id = p_mutation_id then
    return jsonb_build_object('code', 'duplicate', 'data', to_jsonb(current_row));
  end if;
  if current_row.status in ('done', 'cancelled') then
    return jsonb_build_object('code', 'terminal');
  end if;

  if current_row.claimed_by is not null and
     (p_expected_version is null or p_expected_checkpoint_version is null) then
    return jsonb_build_object('code', 'missing_predecessor');
  end if;

  if p_expected_version is not null and
     (current_row.claimed_by is null or current_row.ownership_version <> p_expected_version) then
    return jsonb_build_object('code', 'ownership_changed', 'version', current_row.ownership_version);
  end if;

  if p_expected_checkpoint_version is not null and
     current_row.checkpoint_version <> p_expected_checkpoint_version then
    return jsonb_build_object('code', 'checkpoint_changed',
      'version', current_row.checkpoint_version);
  end if;

  if current_row.claimed_by is null and p_actor_type = 'agent' then
    update tasks set
      claimed_by = p_actor_id, claimed_at = now(), heartbeat_at = now(),
      attempt = attempt + 1, ownership_version = ownership_version + 1,
      status = 'doing'
    where id = p_task_id returning * into current_row;
    claimed_now := true;
  elsif current_row.claimed_by is distinct from p_actor_id and p_actor_type = 'agent' then
    return jsonb_build_object('code', 'already_claimed', 'holder', current_row.claimed_by);
  end if;

  update tasks set
    checkpoint_summary = p_summary,
    checkpoint_payload = p_payload,
    checkpoint_at = now(),
    checkpoint_version = checkpoint_version + 1,
    checkpoint_mutation_id = p_mutation_id,
    heartbeat_at = case when claimed_by = p_actor_id then now() else heartbeat_at end
  where id = p_task_id returning * into current_row;

  if claimed_now then
    insert into task_activity_events
      (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
    values
      (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
       'claimed', jsonb_build_object('agent', p_actor_id, 'attempt', current_row.attempt,
         'ownershipVersion', current_row.ownership_version)),
      (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
       'status_changed', jsonb_build_object('to', 'doing', 'via', 'checkpoint'));
  end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
     'checkpointed', jsonb_build_object('summary', left(p_summary, 300),
       'queuedAt', p_queued_at,
       'checkpointVersion', current_row.checkpoint_version,
       'ownershipVersion', current_row.ownership_version));

  return jsonb_build_object('code', 'ok', 'data', to_jsonb(current_row), 'claimed', claimed_now);
end $$;
