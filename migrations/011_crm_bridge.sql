-- 011 · Мост CRM → Платформа (задача 1.10). Только в одну сторону: БЕРТЕЛ CRM присылает подписанные сообщения,
-- Платформа ничего в CRM не пишет. Материалов дел, номеров дел и фамилий участников здесь нет.
-- Три вида сообщений: перенос профиля исполнителя (один раз, с согласием), короткие предложения госзаказа, число
-- текущих дел исполнителя в CRM (идёт в «дела вне платформы» для подбора).

-- Профиль исполнителя, перенесённый из CRM: связь «номер в CRM» ↔ учётная запись Платформы и то, что нужно подбору.
create table crm_profiles (
  user_id         uuid primary key references users(id),
  crm_id          text not null unique check (length(crm_id) between 1 and 64),
  email           text not null unique check (email = lower(email) and length(email) between 3 and 254),
  languages       text[] not null default '{}',
  qualification   text not null default '' check (length(qualification) <= 300),
  -- Согласие на обработку персональных данных с упоминанием Платформы (без него профиль не переносится).
  consent_version text not null check (length(consent_version) between 1 and 40),
  consent_at      timestamptz not null,
  load_at         timestamptz,
  imported_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Короткое предложение госзаказа: госзаказчик, язык, срок, объём, оплата по ПП № 1240. Принимается — в CRM.
create table crm_offers (
  offer_id     text not null check (length(offer_id) between 1 and 64),
  user_id      uuid not null references users(id),
  customer     text not null check (length(customer) between 1 and 200),
  language     text not null check (length(language) between 1 and 60),
  deadline     date not null,
  volume_amount int not null check (volume_amount between 1 and 1000000),
  volume_unit  text not null check (volume_unit in ('pages', 'signs', 'words', 'hours')),
  status       text not null check (status in ('open', 'closed')),
  received_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (offer_id, user_id)
);
create index crm_offers_open on crm_offers(user_id, deadline) where status = 'open';

-- Принятые сообщения моста: повтор того же сообщения не обрабатывается второй раз (отдаётся прежний итог).
create table crm_bridge_messages (
  id          text primary key check (length(id) between 1 and 100),
  kind        text not null check (kind in ('profiles', 'load', 'offers')),
  result      jsonb not null,
  received_at timestamptz not null default now()
);
