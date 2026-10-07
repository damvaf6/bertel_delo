-- 039 · Перенос срока дела по просьбе исполнителя (задача 2.91): исполнитель просит новую дату с причиной, диспетчер
-- соглашается или отказывает; заказчик видит. Согласие меняет orders.deadline; записи остаются — это история переносов.
create table deadline_requests (
  id            bigserial primary key,
  order_id      uuid not null references orders(id),
  requested_by  uuid not null references users(id),
  old_deadline  date not null,
  new_deadline  date not null,
  reason        text not null,
  requested_at  timestamptz not null default now(),
  outcome       text check (outcome in ('approved', 'declined', 'withdrawn')),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  answer        text
);
create index deadline_requests_order on deadline_requests (order_id);
-- Одна открытая просьба на дело.
create unique index deadline_requests_open on deadline_requests (order_id) where outcome is null;
