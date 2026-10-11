-- 061 · Сертификат платформы к переводу без нотариуса (задача 2а.5, задача штаба 3f617197).
-- Переводчик выдаёт сертификат к своему файлу перевода: номер, QR со ссылкой на открытую страницу проверки.
-- На странице проверки — только номер, дата, языки, ФИО переводчика и отпечаток файла (SHA-256); ни заказчика, ни имени
-- файла, ни текста. Адрес страницы — по случайному коду (номера идут подряд, по ним не перебрать).
-- ФИО переводчика, языки и документ о знании языка (он — только на листе, не на странице) — снимок на день выдачи.
-- Файл удалили (пока дело в работе) — сертификат отозван, запись остаётся.
create sequence certificate_seq;
create table certificates (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,
  code           text not null unique check (code ~ '^[A-Z2-9]{12}$'),
  document_id    uuid not null unique references documents(id),
  order_id       uuid not null references orders(id),
  translator_id  uuid not null references users(id),
  translator_name text not null check (length(translator_name) between 1 and 200),
  language       text not null check (length(language) between 1 and 100),
  direction      text check (direction in ('to_ru', 'from_ru')),
  qualification  text not null default '' check (length(qualification) <= 400),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  issued_at      timestamptz not null default now(),
  revoked_at     timestamptz
);
create index certificates_order on certificates(order_id);
