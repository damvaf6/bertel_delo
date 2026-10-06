-- 034 · Корректировки к аналогам (задача 2.74): список { kind, name?, pct, book?, year?, table? } — вид, значение в процентах, источник
-- (справочник, год, таблица). Правила и расчёт — src/analogs/analogs.mjs.
alter table order_analogs add column adjustments jsonb not null default '[]'::jsonb
  check (jsonb_typeof(adjustments) = 'array');
