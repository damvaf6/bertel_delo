-- 060 · Нотариусы-партнёры (задача 2а.4, задача штаба 3f617197): справочник ведёт администратор платформы.
-- Окна — когда нотариус принимает переводчиков пачкой (обычно 2 раза в неделю): [{ weekday 1–7 (пн–вс), from, to }].
-- Принимает ли нотариус «нотариальный файлом» (В2) для паспортов — до его ответа выключено. Способ оплаты — по умолчанию
-- счёт от платформы. Нотариуса не удаляют, а выключают (active = false): старые заказы могли идти через него.
create table notaries (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null check (length(full_name) between 1 and 200),
  address           text not null check (length(address) between 1 and 300),
  contacts          text not null default '' check (length(contacts) <= 300),
  windows           jsonb not null default '[]' check (jsonb_typeof(windows) = 'array'),
  file_for_identity boolean not null default false,
  payment           text not null default 'invoice' check (payment in ('invoice', 'on_site')),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
