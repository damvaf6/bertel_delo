-- 013 · Дистанционный осмотр (задача 2.3). Исполнитель выдаёт владельцу объекта ссылку: без входа, на ограниченное время,
-- только по одной заявке. Владелец снимает по шагам из описания модуля; у каждого фото — время и геометка. Фото — документы
-- заявки вида «осмотр», в деле у эксперта.

alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('basis', 'other', 'result', 'inspection'));

-- Ссылка: в базе только отпечаток (sha-256) секрета из ссылки — сама ссылка показывается исполнителю один раз.
-- Действует, пока не истёк срок, её не отозвали, владелец не нажал «Готово», дело в работе у того же исполнителя.
create table inspection_links (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references orders(id),
  created_by  uuid not null references users(id),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz not null default now()
);
create index inspection_links_order on inspection_links(order_id, id desc);

-- Фото осмотра: шаг, время получения сервером (ему можно верить), время съёмки по часам телефона и геометка телефона
-- (если владелец разрешил определять место). Без геометки фото принимается, эксперт видит «без геометки».
create table inspection_photos (
  document_id uuid primary key references documents(id),
  link_id     bigint not null references inspection_links(id),
  step        text not null,
  received_at timestamptz not null default now(),
  shot_at     timestamptz,
  lat         double precision check (lat between -90 and 90),
  lon         double precision check (lon between -180 and 180),
  accuracy_m  real check (accuracy_m >= 0),
  check ((lat is null) = (lon is null))
);
create index inspection_photos_link on inspection_photos(link_id);
