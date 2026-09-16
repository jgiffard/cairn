-- A claim is a transition into active work. Terminal tasks are settled history
-- and must never be reopened by a claim, even through the RPC directly.

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
  if not found or before_row.status in ('done', 'cancelled') then return null; end if;

  update tasks
     set claimed_by = p_holder,
         claimed_at = now(),
         heartbeat_at = now(),
         attempt = attempt + 1,
         ownership_version = ownership_version + 1,
         status = case when p_set_doing then 'doing' else status end
   where id = p_task_id
     and status not in ('done', 'cancelled')
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
