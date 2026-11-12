-- 117 · Повреждённые детали таблицей (2.471, «Ущерб автомобилю после ДТП»): эксперт записывает деталь, повреждение,
-- ремонтное воздействие (замена, ремонт, окраска — из описания модуля, parts.actions) и фото осмотра; таблица идёт в раздел
-- «Исследование повреждений» черновика и в Word. Фото хранятся номерами документов: номер «Фото N» в деле может сдвинуться,
-- когда доснимут шаг, — в таблице всегда текущий.
create table damaged_parts (
  id          bigserial primary key,
  order_id    uuid not null references orders(id),
  part        text not null check (char_length(part) between 1 and 120),
  damage      text not null check (char_length(damage) between 1 and 300),
  actions     text[] not null check (cardinality(actions) between 1 and 5),
  photo_ids   uuid[] not null default '{}',
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index damaged_parts_order on damaged_parts (order_id, id);
