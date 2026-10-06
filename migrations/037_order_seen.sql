-- 037 · «Можно продолжать» в «Сегодня» эксперта (задача 2.86): когда исполнитель последний раз открывал своё дело.
-- Что пришло после этого (документы по запросу, осмотр, сообщения заказчика или диспетчера) — строка в «Сегодня»;
-- открыл дело — строка пропадает. Только отметка времени, без содержимого.
create table order_seen (
  order_id uuid not null references orders(id),
  user_id  uuid not null references users(id),
  seen_at  timestamptz not null default now(),
  primary key (order_id, user_id)
);
-- Дела, которые уже в работе, считаются просмотренными в день выкладки — старое не всплывает разом.
insert into order_seen (order_id, user_id)
  select id, executor_user_id from orders where executor_user_id is not null and status in ('in_work', 'review');
