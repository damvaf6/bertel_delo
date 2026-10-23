-- 092 · Проверка юриста перед соглашением (задача штаба 40217197-…-81f7, решение Дамира 23.10.2026): только факты из
-- открытых источников — реестр адвокатов Минюста и опубликованные решения судов. Здесь хранится только то, что делает
-- платформа сама: «о чём дело» одной фразой от российской модели (чтобы не спрашивать модель повторно) и отметки
-- «подтверждаю» / «оспариваю» у карточки или у отдельного дела. Сами сведения реестра и судов не копируются.
create table lawyer_case_subjects (
  source     text not null check (length(source) between 1 and 40),
  case_key   text not null check (length(case_key) between 1 and 200),
  subject    text not null check (length(subject) between 1 and 300),
  model      text,
  created_at timestamptz not null default now(),
  primary key (source, case_key)
);

create table lawyer_check_marks (
  id         bigserial primary key,
  reg_no     text not null check (length(reg_no) between 1 and 40),
  case_key   text check (length(case_key) between 1 and 200),
  user_id    uuid not null references users(id),
  kind       text not null check (kind in ('confirm', 'dispute')),
  note       text check (length(note) <= 500),
  created_at timestamptz not null default now(),
  check (kind = 'confirm' or note is not null)
);
create index lawyer_check_marks_reg on lawyer_check_marks (reg_no, created_at desc);

-- Обращение к модели за «о чём дело» учитывается в дневном лимите и расходе, как остальные.
alter table ai_usage drop constraint ai_usage_purpose_check;
alter table ai_usage add constraint ai_usage_purpose_check check (purpose in ('problem', 'assistant', 'review', 'mail', 'draft', 'analog', 'lawyer'));
