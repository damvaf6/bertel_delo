-- 001 · Каркас ядра: пользователи, организации, вход, заявка (заготовка), документы, журнал действий.
-- Заявка здесь — минимальная: владелец и организация. Поля, статусы и описание модулей — задача 1.3.

create table users (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique check (phone ~ '^\+7\d{10}$'),
  full_name     text not null default '' check (length(full_name) <= 200),
  -- Роль на уровне платформы; обычный пользователь — null. Роли в организации — в org_members.
  platform_role text check (platform_role in ('dispatcher', 'admin')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 300),
  created_at timestamptz not null default now()
);

-- Руководитель (head) видит все дела организации; сотрудник (member) — только свои.
create table org_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('head', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user on org_members(user_id);

-- Одноразовые коды входа: хранится только хэш; попытки не обнуляются новым кодом (исправление Б-14).
create table login_codes (
  id         bigint generated always as identity primary key,
  phone      text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  used_at    timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index login_codes_phone on login_codes(phone, created_at desc);

-- Сессии: в базе только хэш токена; сам токен — в защищённой cookie (исправление Б-9).
create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index sessions_user on sessions(user_id);

create table orders (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id),
  org_id        uuid references organizations(id),
  title         text not null check (length(title) between 1 and 300),
  created_at    timestamptz not null default now()
);
create index orders_owner on orders(owner_user_id);
create index orders_org on orders(org_id);

create table documents (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id),
  uploaded_by uuid not null references users(id),
  filename    text not null check (length(filename) between 1 and 255),
  mime        text not null,
  size_bytes  int not null check (size_bytes >= 0),
  storage_key text not null unique,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index documents_order on documents(order_id) where deleted_at is null;

-- Журнал действий: кто, что, над чем.
create table audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid references users(id),
  action       text not null,
  subject_type text not null,
  subject_id   text not null,
  details      jsonb not null default '{}',
  at           timestamptz not null default now()
);
create index audit_log_subject on audit_log(subject_type, subject_id);
