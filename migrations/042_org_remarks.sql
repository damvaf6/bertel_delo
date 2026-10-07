-- 042 · Свои заготовки замечаний руководителя (задача 2.103): частые пункты замечаний при возврате отчёта эксперту (2.27,
-- 2.93) — сохранить один раз, вставлять одной кнопкой. Свои у каждого руководителя в каждой организации; видит и меняет
-- только он сам. Убранная заготовка остаётся в истории (deleted_at).
create table org_remarks (
  id         bigserial primary key,
  org_id     uuid not null references organizations(id),
  user_id    uuid not null references users(id),
  text       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index org_remarks_owner on org_remarks (org_id, user_id) where deleted_at is null;
