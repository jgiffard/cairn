-- Add shared-workspace roles without changing any existing identity or data id.
-- The pre-existing installation operator becomes the first administrator;
-- users created after this migration are members unless explicitly promoted.

alter table app_users
  add column if not exists role text not null default 'member',
  add column if not exists auth_epoch bigint not null default 0,
  add column if not exists session_epoch bigint not null default 0;

alter table app_sessions
  add column if not exists session_epoch bigint not null default 0;

alter table api_keys
  add column if not exists auth_epoch bigint not null default 0;

do $$
declare
  legacy_user_count integer;
begin
  if not exists (select 1 from app_users where role = 'admin') then
    select count(*)::integer into legacy_user_count from app_users;
    if legacy_user_count = 1 then
      update app_users set role = 'admin', updated_at = now();
    elsif legacy_user_count > 1 then
      raise exception 'multi-user migration requires an explicit administrator when more than one legacy user exists';
    end if;
  end if;
end $$;

alter table app_users
  drop constraint if exists app_users_role_check;
alter table app_users
  add constraint app_users_role_check check (role in ('admin', 'member'));

create index if not exists app_users_active_role_idx
  on app_users(role)
  where deleted_at is null;
