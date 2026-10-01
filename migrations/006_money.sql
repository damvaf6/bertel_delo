-- 006 · Деньги (задача 1.6): цена заявки, оплата заказчиком через ЮKassa по агентской схеме (комиссия платформы 20%),
-- выплата исполнителю, закрывающие документы. Пока поставщик оплаты поддельный; настоящие платежи — по решению Дамира.

-- Цена назначается диспетчером в подборе (до предложения исполнителю); в копейках, от 1 до 10 000 000 рублей.
alter table orders add column price_kop bigint check (price_kop is null or price_kop between 100 and 1000000000);
-- Когда заказчик оплатил (успешный платёж). Без оплаты результат заказчику не выдаётся и заявку не закрыть.
alter table orders add column paid_at timestamptz;

create table payments (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id),
  amount_kop       bigint not null check (amount_kop > 0),
  status           text not null default 'pending' check (status in ('pending', 'succeeded', 'canceled')),
  provider_id      text unique,
  confirmation_url text,
  created_by       uuid not null references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  paid_at          timestamptz
);
-- Не больше одного незавершённого или успешного платежа на заявку: двойной оплаты быть не может.
create unique index payments_one_live on payments(order_id) where status in ('pending', 'succeeded');

-- Выплата исполнителю: одна на заявку (исправление Б-16 наследия — двойная выплата).
create table payouts (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null unique references orders(id),
  executor_user_id uuid not null references users(id),
  amount_kop       bigint not null check (amount_kop > 0),
  commission_kop   bigint not null check (commission_kop >= 0),
  status           text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  provider_id      text,
  failure          text check (length(failure) <= 500),
  attempts         int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  paid_at          timestamptz
);
create index payouts_executor on payouts(executor_user_id, created_at);

-- Закрывающие документы: акт заказчику и отчёт агента исполнителю. Содержимое фиксируется при оплате и не меняется.
create table closing_documents (
  id         uuid primary key default gen_random_uuid(),
  number     bigint generated always as identity unique,
  order_id   uuid not null references orders(id),
  kind       text not null check (kind in ('act', 'agent_report')),
  data       jsonb not null,
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);
