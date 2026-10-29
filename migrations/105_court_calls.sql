-- 105 · Вызов эксперта в суд (задача 2.441): после «готово» заказчик или диспетчер пишет, что эксперта вызывают на
-- заседание, — суд, номер дела, дата и время, адрес, файл повестки или определения. Дело не переоткрывается; эксперту —
-- уведомление. Вызовов по делу может быть несколько (отложили, новое заседание).
create table court_calls (
  id          bigserial primary key,
  order_id    uuid not null references orders(id),
  court       text not null,
  case_no     text not null,
  hearing_at  timestamptz not null,
  address     text not null,
  document_id uuid references documents(id),
  created_by  uuid not null references users(id),
  side        text not null check (side in ('customer', 'dispatcher')),
  created_at  timestamptz not null default now()
);
create index court_calls_order on court_calls (order_id, hearing_at);
create index court_calls_hearing on court_calls (hearing_at);
