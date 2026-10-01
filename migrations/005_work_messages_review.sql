-- 005 · Документы и переписка; проверка результата до выдачи (задача 1.5).
-- Результат работы — документ вида «результат»: загружает исполнитель, заказчик видит его только после проверки
-- («готово»). Переписка по заявке — одна лента: заказчик, исполнитель, диспетчер. Проверка результата — по списку
-- правил модуля (src/modules/), отметки ставит проверяющий человек; каждая сдача на проверку — новый круг.

alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('basis', 'other', 'result'));

-- Номер круга проверки: сколько раз результат сдавали на проверку.
alter table orders add column review_round int not null default 0 check (review_round >= 0);

create table order_messages (
  id        bigint generated always as identity primary key,
  order_id  uuid not null references orders(id),
  author_id uuid not null references users(id),
  side      text not null check (side in ('customer', 'dispatcher', 'executor')),
  body      text not null check (length(body) between 1 and 4000),
  at        timestamptz not null default now()
);
create index order_messages_order on order_messages(order_id, id);

-- Отметки проверки результата: по каждому правилу — «в порядке» или «замечание» с пояснением.
create table result_checks (
  order_id   uuid not null references orders(id),
  round      int not null check (round >= 1),
  check_id   text not null,
  verdict    text not null check (verdict in ('ok', 'issue')),
  note       text check (length(note) <= 1000),
  checked_by uuid not null references users(id),
  at         timestamptz not null default now(),
  primary key (order_id, round, check_id),
  check (verdict = 'ok' or note is not null)
);
