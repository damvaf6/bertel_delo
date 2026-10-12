-- 064 · Настройки модуля, которые правит администратор в кабинете (задача 2а.9, задача штаба 3f617197): цены и правила
-- «Переводов». Каждое сохранение — новая строка (история: кто, когда, что); действует последняя. Нет строк — значения из
-- кода (src/translation/prices.mjs). Строки не удаляются.
create table module_settings (
  id          bigserial primary key,
  module      text not null,
  settings    jsonb not null check (jsonb_typeof(settings) = 'object'),
  changed_by  uuid references users(id),
  changed_at  timestamptz not null default now()
);
create index module_settings_module on module_settings (module, id desc);

-- Строки нотариуса и доставки в заявке — снимок расчёта на момент цены: акт и отчёт агента не меняются, если тарифы потом
-- поправили (вместе с orders.transit_kop, 2а.2).
alter table orders add column transit_lines jsonb;
