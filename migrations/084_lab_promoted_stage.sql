-- ===========================================================================
-- 084: promoting concludes a subject; the delivery stages retire (CAIRN-408)
--
-- A subject with a project ends as that project's tasks: promoting moves it to
-- a completed stage, `promoted`, and archives it. Delivery is tracked by the
-- project's tasks, so Croft's delivery stages leave the board. Idempotent:
--
-- 1. `promoted` (completed, so entering it needs a conclusion) is ensured on
--    every board. One that exists under that name, any case, is kept; its
--    category is set to completed if it was something else.
--
-- 2. The delivery stages (`to implement`, `implementing`, `internal testing`,
--    `ready for rollout`, `rolled out`) are deleted where no live (unarchived)
--    subject is in them. Archived subjects in such a stage move to `promoted`
--    first (the stage foreign key restricts deletes): each keeps its conclusion,
--    or is given one, and its log gets the usual `stage` note.
--
-- 3. A delivery stage that still holds live subjects is left, and named in a
--    NOTICE: those subjects are project work an administrator moves to tasks
--    and concludes or archives by hand; the empty stage is then deleted with
--    `cairn lab stages remove <name>` (or DELETE /api/v1/lab/stages/{id}).
--
-- A new instance's board is then: under construction, to explore, exploring,
-- done, rejected, promoted.
-- ===========================================================================

do $$
declare
  v_delivery constant text[] := array['to implement', 'implementing', 'internal testing', 'ready for rollout', 'rolled out'];
  v_promoted uuid;
  v_created boolean := false;
  v_retired uuid[];
  v_kept text;
begin
  select id into v_promoted from lab_stages where lower(name) = 'promoted';
  if v_promoted is null then
    insert into lab_stages (name, category, color, position)
    values ('promoted', 'completed', '#5f7d8c', (select coalesce(max(position) + 1, 0) from lab_stages))
    returning id into v_promoted;
    v_created := true;
  else
    update lab_stages set category = 'completed' where id = v_promoted and category <> 'completed';
  end if;

  -- The stages that go: delivery stages with no live subject in them.
  select coalesce(array_agg(st.id), '{}')
    into v_retired
    from lab_stages st
   where lower(st.name) = any(v_delivery)
     and not exists (select 1 from subjects s where s.stage_id = st.id and s.archived_at is null);

  insert into subject_notes (subject_id, kind, note, actor_type, actor_id, content_hash)
  select s.id, 'stage', st.name || ' → promoted', 'agent', 'migration 084',
         left(encode(sha256(convert_to('stage' || E'\n' || st.name || E'\n' || 'promoted' || E'\n' || now()::text, 'UTF8')), 'hex'), 32)
    from subjects s
    join lab_stages st on st.id = s.stage_id
   where st.id = any(v_retired)
  on conflict do nothing;

  update subjects s
     set stage_id = v_promoted,
         concluded_at = coalesce(s.concluded_at, s.archived_at),
         conclusion = coalesce(
           nullif(btrim(s.conclusion), ''),
           (select 'Promoted to project ' || p.key || ' (' || p.title || ')' from projects p where p.id = s.project_id),
           'Was in ' || st.name || ' when the Lab''s delivery stages were retired (migration 084).'
         ),
         position = (select coalesce(max(x.position) + 1, 0) from subjects x where x.stage_id = v_promoted)
    from lab_stages st
   where st.id = s.stage_id
     and st.id = any(v_retired);

  delete from lab_stages where id = any(v_retired);

  -- Created last, it sits after whatever is left: position 5 on a default board.
  if v_created then
    update lab_stages
       set position = (select coalesce(max(position) + 1, 0) from lab_stages where id <> v_promoted)
     where id = v_promoted;
  end if;

  select string_agg(format('%s (%s live)', st.name, n.live), ', ' order by st.position)
    into v_kept
    from lab_stages st
    cross join lateral (
      select count(*) as live from subjects s where s.stage_id = st.id and s.archived_at is null
    ) n
   where lower(st.name) = any(v_delivery);
  if v_kept is not null then
    raise notice 'Lab: delivery stages kept, live subjects are in them: %. That is project work: move it to tasks (cairn add "<title>" --project KEY), conclude or archive the subjects, then delete the empty stages (cairn lab stages remove <name>). docs/lab.md, "Stages".', v_kept;
  end if;
end
$$;
