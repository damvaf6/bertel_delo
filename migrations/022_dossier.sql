-- Досье эксперта (2.14; решение Дамира 03.10.2026, в): диплом и образование, квалификационный аттестат, СРО, полисы
-- оценщика и организации. Копию документа эксперт загружает один раз — она лежит в хранилище РФ и прикладывается к
-- отчётам по кнопке. Сведения из досье черновик подставляет в «Сведения об оценщике», ИИ-проверка сверяет с ними отчёт.
-- Запись не удаляется, а скрывается (deleted_at): по ней могли составить отчёт.
create table dossier_items (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references specialists(user_id),
  kind         text not null check (kind in ('education', 'certificate', 'sro', 'policy', 'policy_org')),
  -- Учебное заведение и специальность / направление аттестата / название СРО / страховщик.
  title        text not null check (length(title) between 1 and 300),
  -- Номер диплома, аттестата, полиса; для СРО — номер в реестре.
  number       text check (length(number) <= 100),
  issued_on    date,
  valid_until  date,
  -- Страховая сумма полиса.
  amount_kop   bigint check (amount_kop > 0),
  file_key     text unique,
  file_name    text check (length(file_name) between 1 and 255),
  file_mime    text,
  file_size    int check (file_size >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index dossier_items_user on dossier_items(user_id) where deleted_at is null;

-- Напоминания о сроке документа: за 30 и за 7 дней, при истёкшем — один раз; новый срок — напоминания снова.
create table dossier_reminders (
  item_id     bigint not null references dossier_items(id),
  kind        text not null check (kind in ('d30', 'd7', 'expired')),
  valid_until date not null,
  at          timestamptz not null default now(),
  primary key (item_id, kind, valid_until)
);
