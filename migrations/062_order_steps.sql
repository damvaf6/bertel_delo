-- 062 · Шаги заказа (задача 2а.6, задача штаба 3f617197): передача оригинала, подпись у нотариуса, файл нотариуса, выдача
-- бумаги. Какие шаги у услуги — описание модуля (steps). Отметку ставит исполнитель или диспетчер, заказчик видит, что
-- сделано. Отметку можно снять — запись удаляется (в журнале остаётся). Файл шага удалили — отметка снимается.
create table order_steps (
  order_id    uuid not null references orders(id),
  step        text not null check (step ~ '^[a-z][a-z0-9_]{0,39}$'),
  done_at     timestamptz not null default now(),
  done_by     uuid not null references users(id),
  note        text not null default '' check (length(note) <= 300),
  document_id uuid references documents(id),
  primary key (order_id, step)
);
create index order_steps_document on order_steps(document_id) where document_id is not null;
