-- 106 · «Пояснения к отчёту для суда» (задача 2.444): вопросы суда к эксперту по вызову на заседание — ИИ делит текст
-- определения или повестки на пункты (как замечания, 2.432), эксперт правит вопросы и у каждого пишет пояснение и где в
-- отчёте. Из них — Word «Пояснения эксперта к отчёту».
create table court_questions (
  id         bigserial primary key,
  call_id    bigint not null references court_calls(id),
  pos        int not null,
  body       text not null,
  answer     text,
  place      text,
  by_ai      boolean not null default false,
  updated_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index court_questions_call on court_questions (call_id, pos);
-- Разбор вопросов суда — своё назначение в учёте обращений к ИИ.
alter table ai_usage drop constraint ai_usage_purpose_check;
alter table ai_usage add constraint ai_usage_purpose_check check (purpose in ('problem', 'assistant', 'review', 'mail', 'draft', 'analog', 'lawyer', 'remarks', 'court'));
