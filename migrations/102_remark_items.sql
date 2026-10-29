-- 102 · Замечания пунктами (задача 2.432): эксперт разбирает замечания к сданному отчёту на пункты (ИИ предлагает, эксперт
-- правит) и у каждого отмечает «исправлено в отчёте» или «пояснение без правки». Пункты — по кругу замечаний (orders.remarks_round).
create table remark_items (
  id bigserial primary key,
  order_id uuid not null references orders(id),
  round int not null,
  pos int not null,
  body text not null,
  resolution text check (resolution in ('fixed', 'explained')),
  note text,
  by_ai boolean not null default false,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index remark_items_order on remark_items (order_id, round, pos);
-- Разбор замечаний на пункты — своё назначение в учёте обращений к ИИ.
alter table ai_usage drop constraint ai_usage_purpose_check;
alter table ai_usage add constraint ai_usage_purpose_check check (purpose in ('problem', 'assistant', 'review', 'mail', 'draft', 'analog', 'lawyer', 'remarks'));
