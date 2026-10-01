-- 003 · Единая «Заявка» (задача 1.3): услуга из описания модуля, поля заявки, срок, основание, статусы и их история.
-- Перечень услуг и поля — не в схеме, а в описании модуля (src/modules/); здесь хранятся только выбранная услуга
-- и заполненные значения. Заявки-заготовки из 001 остаются без услуги, пока их не заполнят (статус «новая»).

alter table orders
  add column module       text,
  add column service      text,
  -- новая → подбор → ждёт исполнителя → в работе → проверка → готово → закрыто; отменена (src/orders/workflow.mjs)
  add column status       text not null default 'new'
    check (status in ('new', 'matching', 'awaiting_executor', 'in_work', 'review', 'done', 'closed', 'cancelled')),
  -- Срок: к какой дате нужен результат (обязателен для отправки — решение Дамира 30.09.2026).
  add column deadline     date,
  -- Основание: договор (оформит платформа) или определение суда — номер, дата и файл (решение Дамира 30.09.2026).
  add column basis_kind   text not null default 'contract' check (basis_kind in ('contract', 'court')),
  add column basis_number text check (length(basis_number) <= 100),
  add column basis_date   date,
  -- Значения полей заявки по описанию услуги.
  add column fields       jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  add column submitted_at timestamptz,
  add column updated_at   timestamptz not null default now(),
  add constraint orders_service_pair check ((module is null) = (service is null)),
  -- Отправленная заявка всегда с услугой и сроком (отменить можно и незаполненную «новую»).
  add constraint orders_submitted_ready check (status in ('new', 'cancelled') or (module is not null and deadline is not null));

create index orders_status on orders(status);
create index orders_open_deadline on orders(deadline) where status not in ('done', 'closed', 'cancelled');

-- История статусов: кто (сторона и человек), откуда, куда, почему. Заказчик видит каждый шаг.
create table order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references orders(id),
  from_status text,
  to_status   text not null,
  actor_id    uuid references users(id),
  side        text not null check (side in ('customer', 'dispatcher')),
  reason      text check (length(reason) <= 1000),
  at          timestamptz not null default now()
);
create index order_status_history_order on order_status_history(order_id, id);

-- Вид документа: основание (например, определение суда) или прочее.
alter table documents add column kind text not null default 'other' check (kind in ('basis', 'other'));
