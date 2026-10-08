-- 045 · Заметки эксперта к делу (задача 2.115): свои записи исполнителя («уточнить этаж у заказчика»), видит только автор,
-- пока он исполнитель дела. По желанию — напомнить в день remind_on: одно уведомление в ленту (reminded_at), строка в
-- «Сегодня». Отметка «сделано» — done_at; удалённая заметка остаётся с deleted_at и нигде не показывается.
create table order_notes (
  id           bigserial primary key,
  order_id     uuid not null references orders(id),
  author_id    uuid not null references users(id),
  body         text not null,
  remind_on    date,
  reminded_at  timestamptz,
  done_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index order_notes_order on order_notes (order_id, author_id) where deleted_at is null;
create index order_notes_remind on order_notes (remind_on) where reminded_at is null and done_at is null and deleted_at is null;
