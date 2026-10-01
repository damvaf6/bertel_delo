-- 008 · Деньги по решению Дамира 01.10.2026 (задача 1.6а): заказчик платит при заказе (после назначения цены, до
-- предложения исполнителю); выплата исполнителю — при выдаче результата («готово»); возврат при отмене.
-- Отмена после начала работ: по вине исполнителя — полный возврат; отказ заказчика — диспетчер указывает долю
-- сделанной работы, исполнителю за неё (80%), остаток — заказчику.

-- По чьей причине отменена заявка после начала работ и какая доля работы сделана (для отказа заказчика).
alter table orders add column cancel_fault text check (cancel_fault is null or cancel_fault in ('executor', 'customer'));
alter table orders add column done_percent int check (done_percent is null or done_percent between 0 and 100);

-- Возврат заказчику: один на заявку (как и выплата исполнителю). Сумма — из нашей записи об оплате.
create table refunds (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null unique references orders(id),
  payment_id   uuid not null references payments(id),
  amount_kop   bigint not null check (amount_kop > 0),
  reason       text check (length(reason) <= 1000),
  status       text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  provider_id  text,
  failure      text check (length(failure) <= 500),
  attempts     int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  refunded_at  timestamptz
);

-- Закрывающие документы: добавляется документ о возврате заказчику.
alter table closing_documents drop constraint closing_documents_kind_check;
alter table closing_documents add constraint closing_documents_kind_check check (kind in ('act', 'agent_report', 'refund'));
