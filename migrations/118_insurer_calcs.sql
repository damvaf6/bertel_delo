-- 118 · Сверка с актом и расчётом страховой (2.475, «Ущерб автомобилю после ДТП»): эксперт вносит детали из акта осмотра
-- страховой и её сумму (с учётом износа или без), свою сумму на той же основе; программа сравнивает детали страховой с
-- таблицей повреждённых деталей дела (damaged_parts) — что совпадает, что эксперт добавил, что исключил — и считает разницу.
-- Одна сверка на дело; таблица идёт в раздел «Исследование повреждений» черновика и в Word.
create table insurer_calcs (
  order_id     uuid primary key references orders(id),
  basis        text not null default '' check (char_length(basis) <= 200),
  wear         text not null check (wear in ('with', 'without')),
  insurer_kop  bigint not null check (insurer_kop between 0 and 100000000000),
  own_kop      bigint check (own_kop between 0 and 100000000000),
  parts        text[] not null default '{}' check (cardinality(parts) <= 60),
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
