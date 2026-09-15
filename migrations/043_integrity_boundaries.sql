-- P0 integrity boundaries: ownership generations, replay idempotency, and
-- atomic ownership/checkpoint transitions. Additive columns keep the N-1
-- application compatible while migrations run before the new image starts.

alter table tasks
  add column if not exists ownership_version bigint not null default 0,
  add column if not exists checkpoint_version bigint not null default 0,
  add column if not exists checkpoint_mutation_id uuid;

alter table task_comments
  add column if not exists mutation_id uuid;

create unique index if not exists task_comments_mutation_key
  on task_comments (task_id, mutation_id);

create or replace function claim_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_holder text,
  p_stale_before timestamptz,
  p_set_doing boolean default true
) returns jsonb language plpgsql as $$
declare
  before_row tasks%rowtype;
  claimed tasks%rowtype;
begin
  select t.* into before_row
    from tasks t join projects p on p.id = t.project_id
   where t.id = p_task_id and p.owner_user_id = p_owner_user_id;
  if not found then return null; end if;

  update tasks
     set claimed_by = p_holder,
         claimed_at = now(),
         heartbeat_at = now(),
         attempt = attempt + 1,
         ownership_version = ownership_version + 1,
         status = case when p_set_doing then 'doing' else status end
   where id = p_task_id
     and (claimed_by is null or heartbeat_at < p_stale_before)
  returning * into claimed;
  if not found then return null; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, claimed.project_id, claimed.id, p_actor_type, p_actor_id,
     'claimed', jsonb_build_object('agent', p_holder, 'attempt', claimed.attempt,
       'ownershipVersion', claimed.ownership_version));

  if claimed.status is distinct from before_row.status then
    insert into task_activity_events
      (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
    values
      (p_owner_user_id, claimed.project_id, claimed.id, p_actor_type, p_actor_id,
       'status_changed', jsonb_build_object('from', before_row.status, 'to', claimed.status, 'via', 'claim'));
  end if;

  return to_jsonb(claimed);
end $$;

create or replace function release_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_version bigint,
  p_expected_holder text default null
) returns jsonb language plpgsql as $$
declare released tasks%rowtype;
begin
  update tasks t
     set claimed_by = null, claimed_at = null, heartbeat_at = null
    from projects p
   where t.id = p_task_id and p.id = t.project_id
     and p.owner_user_id = p_owner_user_id
     and t.ownership_version = p_expected_version
     and (p_expected_holder is null or t.claimed_by = p_expected_holder)
  returning t.* into released;
  if not found then return null; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, released.project_id, released.id, p_actor_type, p_actor_id,
     'released', jsonb_build_object('previousHolder', p_expected_holder,
       'ownershipVersion', p_expected_version));
  return to_jsonb(released);
end $$;

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

  -- Existing claims must carry both predecessors. Nulls are reserved for the
  -- atomic initial-claim path below; otherwise a stale caller could bypass
  -- generation and checkpoint ordering by omitting its headers.
  if current_row.claimed_by is not null and
     (p_expected_version is null or p_expected_checkpoint_version is null) then
    return jsonb_build_object('code', 'missing_predecessor');
  end if;

  -- A queued checkpoint that belonged to a released generation must not
  -- resurrect that claim. Only a live checkpoint with no prior generation may
  -- infer an initial claim.
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

create or replace function reconcile_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_holder text,
  p_expected_version bigint,
  p_expected_heartbeat timestamptz,
  p_expected_updated_at timestamptz,
  p_reopen boolean,
  p_note text,
  p_content_hash text
) returns boolean language plpgsql as $$
declare released tasks%rowtype;
begin
  update tasks t set
    claimed_by = null, claimed_at = null, heartbeat_at = null,
    status = case when p_reopen then 'todo' else t.status end
  from projects p
  where t.id = p_task_id and p.id = t.project_id
    and p.owner_user_id = p_owner_user_id
    and t.claimed_by = p_expected_holder
    and t.ownership_version = p_expected_version
    and t.heartbeat_at is not distinct from p_expected_heartbeat
    and t.updated_at is not distinct from p_expected_updated_at
  returning t.* into released;
  if not found then return false; end if;

  insert into task_notes
    (task_id, actor_type, actor_id, kind, note, content_hash)
  values (released.id, p_actor_type, p_actor_id, 'handoff', p_note, p_content_hash)
  on conflict (task_id, content_hash) do nothing;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, released.project_id, released.id, p_actor_type, p_actor_id,
     'released', jsonb_build_object('reason', 'reconcile', 'reopened', p_reopen,
       'ownershipVersion', p_expected_version));
  return true;
end $$;
