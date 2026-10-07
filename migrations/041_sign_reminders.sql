-- 041 · Напоминание руководителю о подписи организации (задача 2.99): эксперт подписал отчёт, организация ещё нет —
-- эксперт может напомнить руководителям организации, не чаще раза в сутки по одному делу. Здесь — когда и кто напомнил.
create table sign_reminders (
  id          bigserial primary key,
  order_id    uuid not null references orders(id),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references users(id),
  created_at  timestamptz not null default now()
);
create index sign_reminders_order on sign_reminders (order_id, created_at desc);
