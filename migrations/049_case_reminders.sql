-- 049 · Руководитель напоминает эксперту о деле (задача 2.125): по делу в работе эксперта от организации — «Напомнить
-- эксперту» одной кнопкой, не чаще раза в сутки по делу (как «Напомнить руководителю» эксперта, 2.99). Здесь — когда, кто
-- напомнил и кому: после передачи дела другому эксперту напоминания прежнему не в счёт.
create table case_reminders (
  id            bigserial primary key,
  order_id      uuid not null references orders(id),
  org_id        uuid not null references organizations(id),
  user_id       uuid not null references users(id),
  expert_id     uuid not null references users(id),
  created_at    timestamptz not null default now()
);
create index case_reminders_order on case_reminders (order_id, expert_id, created_at desc);
