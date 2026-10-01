-- 007 · Уведомления (задача 1.7): лента уведомлений в кабинете, настройки по видам, очередь отправки СМС.
-- Виды и события уведомлений — данными в src/notify/registry.mjs; здесь — только их коды.
-- Текст уведомления не хранится: он собирается из реестра при показе. Название заявки показывается, только пока
-- у получателя есть к ней доступ. В СМС — без персональных данных и без названия заявки (только её короткий номер).

create table notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users(id),
  type       text not null check (type ~ '^[a-z_]{1,40}$'),
  event      text not null check (event ~ '^[a-z_]{1,40}$'),
  order_id   uuid references orders(id),
  org_id     uuid references organizations(id),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user on notifications(user_id, id desc);
create index notifications_unread on notifications(user_id) where read_at is null;

-- Настройки получателя: присылать ли СМС по виду уведомлений. Нет строки — действует значение вида по умолчанию.
-- В кабинете уведомления показываются всегда.
create table notification_settings (
  user_id    uuid not null references users(id) on delete cascade,
  type       text not null check (type ~ '^[a-z_]{1,40}$'),
  sms        boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);

-- Очередь отправки по внешним каналам. Пока только СМС (почта — когда появится адрес в профиле).
-- Строка без уведомления — СМС человеку без учётной записи (приглашение в организацию по номеру).
create table notification_deliveries (
  id              bigint generated always as identity primary key,
  notification_id bigint references notifications(id),
  channel         text not null check (channel in ('sms')),
  phone           text not null check (phone ~ '^\+7\d{10}$'),
  body            text not null check (length(body) between 1 and 300),
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts        int not null default 0,
  error           text check (length(error) <= 500),
  provider_id     text,
  next_at         timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index notification_deliveries_pending on notification_deliveries(next_at) where status = 'pending';
