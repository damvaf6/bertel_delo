-- Напоминания о сроках (разбор 03.10.2026, 2.13; устав, раздел 1а: «напоминания о сроках»). Каждое напоминание по
-- заявке — один раз: за 3 дня и за 1 день до срока исполнителю, при просрочке — исполнителю и диспетчерам.
-- Срок перенесли — напоминания по новому сроку приходят снова (ключ — заявка, вид и сам срок).
create table deadline_reminders (
  order_id uuid not null references orders(id) on delete cascade,
  kind     text not null check (kind in ('d3', 'd1', 'overdue')),
  deadline date not null,
  at       timestamptz not null default now(),
  primary key (order_id, kind, deadline)
);
