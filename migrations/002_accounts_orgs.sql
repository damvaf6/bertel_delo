-- 002 · Учётки и слой «организация» (задача 1.2): три роли в организации, приглашения по номеру,
-- реквизиты организации, канал доставки кода входа (СМС или звонок).

-- Роли в организации (решение Дамира 30.09.2026):
--   head   — руководитель: видит все дела, распределяет, управляет составом и ролями;
--   senior — старший (партнёр): видит все дела и распределяет, состав не меняет;
--   member — сотрудник: только свои дела.
alter table org_members drop constraint org_members_role_check;
alter table org_members add constraint org_members_role_check check (role in ('head', 'senior', 'member'));

alter table organizations
  add column inn        text check (inn ~ '^(\d{10}|\d{12})$'),
  add column created_by uuid references users(id);

-- Приглашение в организацию — на номер телефона. Приглашённый видит его после входа и сам принимает или отклоняет.
create table org_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  phone       text not null check (phone ~ '^\+7\d{10}$'),
  role        text not null check (role in ('head', 'senior', 'member')),
  invited_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  declined_at timestamptz,
  revoked_at  timestamptz
);
-- Не больше одного действующего приглашения на номер в организацию.
create unique index org_invites_pending on org_invites(org_id, phone)
  where accepted_at is null and declined_at is null and revoked_at is null;
create index org_invites_phone on org_invites(phone);

alter table login_codes add column channel text not null default 'sms' check (channel in ('sms', 'call'));
