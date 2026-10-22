-- ===========================================================================
-- 088: validate what 087 added NOT VALID (CAIRN-426)
--
-- Its own file, so its own transaction: validating takes SHARE UPDATE
-- EXCLUSIVE, which lets reads and writes through, where 087's ADD CONSTRAINT
-- took ACCESS EXCLUSIVE. Validating a constraint that is already valid is a
-- no-op, so this can run again.
-- ===========================================================================

alter table task_activity_events validate constraint task_activity_events_event_check;
