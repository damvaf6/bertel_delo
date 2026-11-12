-- 116 · Извещение об осмотре (2.470, «Ущерб автомобилю после ДТП»): эксперт сообщает страховой и второму участнику ДТП дату,
-- время и место осмотра — образец Word; отметка «извещены, как и когда» идёт строкой в раздел «Осмотр» черновика.
-- Кого извещают (party) — из описания модуля (notice.parties). Пока не отмечено — how и sent_on пусты.
create table inspection_notices (
  id          bigserial primary key,
  order_id    uuid not null references orders(id),
  party       text not null check (party ~ '^[a-z_]{1,30}$'),
  name        text not null check (char_length(name) between 1 and 200),
  inspect_at  timestamptz not null,
  place       text not null check (char_length(place) between 1 and 300),
  how         text check (how is null or how ~ '^[a-z_]{1,20}$'),
  sent_on     date,
  marked_at   timestamptz,
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  check ((how is null) = (sent_on is null))
);
create index inspection_notices_order on inspection_notices (order_id, inspect_at, id);
