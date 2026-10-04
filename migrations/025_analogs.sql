-- Аналоги в деле (2.32; решение Дамира 04.10.2026, вопрос 18 — план docs/analogi-plan.md, способ А): эксперт сам находит
-- объявление и прикладывает ссылку и скриншот (или PDF страницы); платформа ставит своё время получения и отпечаток файла,
-- ИИ предлагает признаки со скриншота, эксперт проверяет и подтверждает. С сайтов платформа ничего не собирает.
-- Имя и телефон продавца не сохраняются (в признаках их нет). Запись не удаляется, а скрывается: по ней могли составить отчёт.
create table order_analogs (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references orders(id),
  author_id     uuid not null references users(id),
  url           text not null check (length(url) between 8 and 2000),
  -- Ссылка без «хвоста» (метки рекламы, якорь) — по ней ищутся повторы в деле.
  url_key       text not null check (length(url_key) between 1 and 2000),
  -- Признаки аналога (цена, дата объявления, регион и признаки из описания модуля): то, что подтвердил или ввёл эксперт.
  fields        jsonb not null default '{}'::jsonb,
  -- Что предложил ИИ (те же ключи) и какой моделью; эксперт видит, что пришло от ИИ, пока не подтвердит.
  suggested     jsonb,
  ai_model      text,
  confirmed_at  timestamptz,
  -- Скриншот или PDF страницы объявления: в хранилище РФ; время получения — время платформы, отпечаток — SHA-256.
  file_key      text unique,
  file_name     text check (length(file_name) between 1 and 255),
  file_mime     text,
  file_size     int check (file_size >= 0),
  file_sha256   text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  received_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index order_analogs_order on order_analogs(order_id) where deleted_at is null;

-- Обращение к модели «признаки аналога со скриншота» учитывается в лимите и расходе, как остальные.
alter table ai_usage drop constraint ai_usage_purpose_check;
alter table ai_usage add constraint ai_usage_purpose_check check (purpose in ('problem', 'assistant', 'review', 'mail', 'draft', 'analog'));
