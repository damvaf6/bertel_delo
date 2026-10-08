-- 048 · Утренняя сводка руководителю «На сегодня по организации» (задача 2.121): раз в день, после 8:00 по Москве, — одно
-- уведомление руководителю на каждую его организацию: сколько дел ждут подписи организации, сколько просьб экспертов передать
-- дело, сколько дел экспертов со сроком сегодня и с прошедшим сроком. Строка на руководителя, организацию и день (даже когда
-- сводки нет — чтобы не считать заново каждую минуту); цифры — для текста в ленте. Ни названий дел, ни имён.
create table org_morning_digests (
  user_id         uuid not null references users(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  day             date not null,
  sign            int not null default 0,
  handover        int not null default 0,
  due             int not null default 0,
  overdue         int not null default 0,
  notification_id bigint references notifications(id),
  created_at      timestamptz not null default now(),
  primary key (user_id, org_id, day)
);
create index org_morning_digests_notification on org_morning_digests (notification_id) where notification_id is not null;
