-- Возврат отчёта руководителем организации эксперту (2.27): до подписи организации руководитель возвращает файл с
-- замечанием; подпись эксперта с файла снимается (строка document_signatures удаляется, файл подписи остаётся в хранилище,
-- его ключ — здесь, для истории). Историю видят эксперт (исполнитель) и руководитель; заказчик и диспетчер — нет.
create table org_returns (
  id bigserial primary key,
  order_id uuid not null references orders(id),
  document_id uuid not null references documents(id),
  org_id uuid not null references organizations(id),
  executor_user_id uuid not null references users(id),
  returned_by uuid not null references users(id),
  filename text not null,
  comment text not null,
  signature_key text,
  created_at timestamptz not null default now()
);
create index org_returns_order on org_returns(order_id, id);
