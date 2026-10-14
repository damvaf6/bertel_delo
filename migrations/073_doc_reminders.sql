-- 073 · «Напомнить заказчику» о запрошенных документах (задача 2.234): документ запрошен 3 дня назад и не пришёл —
-- исполнитель одной кнопкой напоминает заказчику, не чаще раза в сутки по одному делу. Здесь — когда и кто напомнил.
create table doc_reminders (
  id          bigserial primary key,
  order_id    uuid not null references orders(id),
  user_id     uuid not null references users(id),
  titles      text[] not null,
  created_at  timestamptz not null default now()
);
create index doc_reminders_order on doc_reminders (order_id, created_at desc);
