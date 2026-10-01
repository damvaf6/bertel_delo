-- 004 · Специалист, допуски, подбор исполнителя (задача 1.4).
-- Специалист — обычная учётная запись с профилем исполнителя; допуски (на какие услуги можно давать дела) выдаёт
-- только администратор платформы. Подбор считается по признакам (src/matching/score.mjs), диспетчер видит оценку.

create table specialists (
  user_id       uuid primary key references users(id),
  -- Принимает ли предложения прямо сейчас (специалист сам переключает).
  active        boolean not null default true,
  -- Где работает: 'moscow' — Москва, 'mo' — Московская область (значения поля «Где находится объект»).
  regions       text[] not null default '{moscow,mo}' check (regions <@ array['moscow', 'mo']),
  -- Сколько дел одновременно считается нормальной нагрузкой.
  capacity      int not null default 5 check (capacity between 1 and 50),
  -- Дела вне платформы (позже приходит из моста CRM → Платформа, задача 1.10).
  external_load int not null default 0 check (external_load between 0 and 500),
  created_at    timestamptz not null default now()
);

-- Допуск: без него специалист не получает дела этой услуги (обязательное условие подбора).
create table specialist_permits (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references specialists(user_id),
  module     text not null,
  service    text not null,
  valid_until date,
  granted_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (user_id, module, service)
);

alter table orders add column executor_user_id uuid references users(id);
create index orders_executor on orders(executor_user_id) where executor_user_id is not null;
-- Дело с исполнителем — только на этапах после предложения (и не в «подборе»).
alter table orders add constraint orders_executor_stage
  check (executor_user_id is null or status in ('awaiting_executor', 'in_work', 'review', 'done', 'closed'));

-- Предложения: кому, с какой оценкой, чем кончилось. По ним считается «качество прошлых работ» (доля принятых).
create table order_offers (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references orders(id),
  specialist_id uuid not null references users(id),
  score       jsonb not null,
  offered_by  uuid references users(id),
  offered_at  timestamptz not null default now(),
  outcome     text check (outcome in ('accepted', 'declined', 'withdrawn')),
  outcome_at  timestamptz,
  reason      text check (length(reason) <= 1000)
);
create index order_offers_order on order_offers(order_id, id);
create index order_offers_specialist on order_offers(specialist_id, id);
create unique index order_offers_open on order_offers(order_id) where outcome is null;

alter table order_status_history drop constraint order_status_history_side_check;
alter table order_status_history add constraint order_status_history_side_check check (side in ('customer', 'dispatcher', 'executor'));
