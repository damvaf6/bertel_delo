-- 110 · Аккредитация в банке (2.451). Отчёт для ипотеки или залога банк принимает только от оценщика или организации,
-- аккредитованных в этом банке. У эксперта — запись досье вида bank: банк из списка поля заявки bank или свой
-- (other + название в title), номер и дата решения банка, срок, копия. У организации — свои аккредитации, вносит
-- руководитель, видят сотрудники. Запись не удаляется, а скрывается (deleted_at).
alter table dossier_items drop constraint dossier_items_kind_check;
alter table dossier_items add constraint dossier_items_kind_check
  check (kind in ('education', 'certificate', 'sro', 'policy', 'policy_org', 'language', 'bank'));
alter table dossier_items add column bank text check (length(bank) between 1 and 20);
alter table dossier_items add constraint dossier_items_bank_kind check ((kind = 'bank') = (bank is not null));

create table org_accreditations (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references organizations(id),
  bank         text not null check (length(bank) between 1 and 20),
  -- Название банка (для своего банка — как ввёл руководитель).
  title        text not null check (length(title) between 1 and 300),
  -- Номер решения банка.
  number       text check (length(number) <= 100),
  issued_on    date,
  valid_until  date,
  file_key     text unique,
  file_name    text check (length(file_name) between 1 and 255),
  file_mime    text,
  file_size    int check (file_size >= 0),
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index org_accreditations_org on org_accreditations(org_id) where deleted_at is null;
