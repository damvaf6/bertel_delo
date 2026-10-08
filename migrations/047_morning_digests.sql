-- 047 · Утренняя сводка эксперту «На сегодня» (задача 2.119): раз в день, после 8:00 по Москве, — одно уведомление: сколько
-- дел сдать сегодня, сколько просрочено, сколько выездов на объект сегодня и сколько ссылок на осмотр истекают в ближайшие
-- сутки. Строка на каждого специалиста и день (даже когда сводки нет — чтобы не считать заново каждую минуту); цифры — для
-- текста уведомления в ленте (сам текст, как и у остальных уведомлений, не хранится). Ни названий дел, ни имён.
create table morning_digests (
  user_id         uuid not null references users(id) on delete cascade,
  day             date not null,
  due             int not null default 0,
  overdue         int not null default 0,
  visits          int not null default 0,
  links           int not null default 0,
  notification_id bigint references notifications(id),
  created_at      timestamptz not null default now(),
  primary key (user_id, day)
);
create index morning_digests_notification on morning_digests (notification_id) where notification_id is not null;
