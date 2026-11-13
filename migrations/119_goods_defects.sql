-- 119 · Недостатки товара таблицей (2.482, товароведческая экспертиза): эксперт записывает недостаток, где он и какой
-- размер, характер (производственный, эксплуатационный, не установлен, не подтвердился — defects.natures в модуле), признаки
-- и фото осмотра; таблица идёт в раздел «5. Исследование» черновика и в Word. Фото — номерами документов, как у деталей ДТП
-- (117): номер «Фото N» в деле может сдвинуться, в таблице всегда текущий.
create table goods_defects (
  id          bigserial primary key,
  order_id    uuid not null references orders(id),
  defect      text not null check (char_length(defect) between 1 and 200),
  place       text not null check (char_length(place) between 1 and 300),
  nature      text not null check (char_length(nature) between 1 and 20),
  signs       text not null default '' check (char_length(signs) <= 600),
  photo_ids   uuid[] not null default '{}',
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index goods_defects_order on goods_defects (order_id, id);
