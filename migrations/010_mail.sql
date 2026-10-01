-- 010 · Заявка по письму (задача 1.9): особый адрес, письмо с вложениями → ИИ разбирает → заявка-черновик и ответ номером;
-- ответы в той же переписке; готовый результат — ответом в ту же переписку.
-- Письма принимаются только с подключённого и подтверждённого адреса человека и только с подтверждённой подлинностью
-- отправителя (проверку SPF/DKIM делает почтовый сервер).

-- Подключённый адрес почты: один на человека, один адрес — у одного человека. org_id — от чьего имени заявки по письмам
-- (null — лично). Код подтверждения хранится только хэшем.
create table mail_addresses (
  user_id       uuid primary key references users(id),
  email         text not null check (email = lower(email) and length(email) between 3 and 254),
  org_id        uuid references organizations(id),
  code_hash     text,
  code_expires  timestamptz,
  code_sent_at  timestamptz,
  attempts      int not null default 0,
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now()
);
-- Подтверждённый адрес — только у одного человека (неподтверждённый ввод другого не мешает).
create unique index mail_addresses_email on mail_addresses(email) where confirmed_at is not null;

-- Переписка по заявке: на какой адрес писать, какой темой и на какое последнее письмо человека отвечать.
create table mail_threads (
  order_id        uuid primary key references orders(id),
  user_id         uuid not null references users(id),
  email           text not null,
  subject         text not null,
  last_message_id text,
  created_at      timestamptz not null default now()
);

-- Входящие письма. Текст хранится в базе в России (персональные данные); вложения — в хранилище, если письмо принято.
-- outcome: created — создана заявка; updated — дополнена; submitted — отправлена по ответу «Отправить»; message — текст
-- ушёл в переписку по заявке; unknown_sender — адрес не подключён; not_authenticated — подлинность не подтверждена;
-- no_service — не понятно, какая услуга; no_access — ответ в чужую или недоступную переписку; failed — ИИ недоступен
-- после всех попыток или исчерпан дневной лимит; auto_reply — автоответ («я в отпуске»), не обрабатывается.
create table mail_inbound (
  id           bigint generated always as identity primary key,
  provider_id  text not null,
  message_id   text,
  from_email   text not null,
  subject      text not null default '',
  body         text not null default '',
  in_reply_to  text[] not null default '{}',
  attachments  jsonb not null default '[]',
  user_id      uuid references users(id),
  order_id     uuid references orders(id),
  status       text not null default 'pending' check (status in ('pending', 'done')),
  outcome      text check (outcome in ('created', 'updated', 'submitted', 'message', 'unknown_sender', 'not_authenticated',
                                       'no_service', 'no_access', 'failed', 'auto_reply')),
  attempts     int not null default 0,
  next_at      timestamptz not null default now(),
  received_at  timestamptz not null default now(),
  done_at      timestamptz
);
create unique index mail_inbound_provider on mail_inbound(provider_id);
create index mail_inbound_pending on mail_inbound(next_at) where status = 'pending';
create index mail_inbound_from on mail_inbound(from_email, received_at desc);

-- Исходящие письма: записываются в той же транзакции, что и событие; отправляются после неё, с повторами.
-- Вложения (результат работы) берутся из документов заявки в момент отправки.
create table mail_outbox (
  id           bigint generated always as identity primary key,
  order_id     uuid references orders(id),
  to_email     text not null,
  subject      text not null,
  body         text not null,
  message_id   text not null,
  in_reply_to  text,
  result_files boolean not null default false,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts     int not null default 0,
  next_at      timestamptz not null default now(),
  error        text,
  provider_id  text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create unique index mail_outbox_message on mail_outbox(message_id);
create index mail_outbox_pending on mail_outbox(next_at) where status = 'pending';
create index mail_outbox_order on mail_outbox(order_id, id);

-- Разбор письма ИИ учитывается в дневном лимите человека.
alter table ai_usage drop constraint ai_usage_purpose_check;
alter table ai_usage add constraint ai_usage_purpose_check check (purpose in ('problem', 'assistant', 'review', 'mail'));
