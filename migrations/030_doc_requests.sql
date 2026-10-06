-- 030 · Запрос недостающих документов (задача 2.64): исполнитель одной кнопкой просит у заказчика документы из списка
-- услуги (описание модуля, request_docs) или своими словами; заказчик загружает файл к каждому — отметка «получено».
create table doc_requests (
  id           bigserial primary key,
  order_id     uuid not null references orders(id),
  item_id      text check (length(item_id) <= 40),
  title        text not null check (length(title) between 1 and 200),
  note         text check (length(note) <= 1000),
  requested_by uuid not null references users(id),
  requested_at timestamptz not null default now(),
  document_id  uuid references documents(id),
  fulfilled_at timestamptz,
  cancelled_at timestamptz
);
create index doc_requests_order on doc_requests (order_id, id);
create unique index doc_requests_open_item on doc_requests (order_id, item_id) where cancelled_at is null and fulfilled_at is null and item_id is not null;
