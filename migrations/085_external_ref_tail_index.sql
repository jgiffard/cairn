-- ===========================================================================
-- 085: another tracker's ref finds the task that is that issue (CAIRN-413)
--
-- A ref-shaped search whose key is no project here (`DIS-2237` on an instance
-- whose project is DISPOF) is read as another tracker's ref and matched
-- against the trailing `KEY-n` of `tasks.external_ref`: the text after the
-- last `/` or `:`, or the whole value, upper-cased. So `linear.app/DIS-2237`,
-- `croft:croft.montytorr.com/T-1`, `cairn.app.dispofi.fr/DISPOF-12` and a bare
-- `LEGACY-373` all resolve, in any case.
--
-- This indexes that expression, so the lookup is an index probe and not a
-- `like '%…'` scan of every task. The expression must stay identical to the
-- one in tasksByExternalRef (src/lib/api/search.ts), or the index goes unused.
-- Not unique: two trackers can each have a `T-1`.
-- ===========================================================================

create index if not exists tasks_external_ref_tail_idx
  on tasks (upper(regexp_replace(external_ref, '^.*[/:]', '')))
  where external_ref is not null;
