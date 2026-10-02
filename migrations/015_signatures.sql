-- 015 · Подпись заключения УКЭП и выдача (задача 2.5). Эксперт подписывает файл результата усиленной квалифицированной
-- электронной подписью через поставщика подписи (до решения Дамира — поддельный, только на площадке). Подпись открепленная:
-- сам файл не меняется, подпись — отдельный файл рядом. Заказчик получает файл и подпись после проверки и оплаты.

-- Одна подпись на файл результата. digest — SHA-256 файла в момент подписи: по нему видно, что файл не меняли.
-- certificate — сведения сертификата (владелец, кем выдан, номер, срок), как их вернул поставщик.
-- checked_at / checked_ok — последняя проверка подписи (при подписании и по кнопке «Проверить подпись»).
create table document_signatures (
  id           bigint generated always as identity primary key,
  document_id  uuid not null unique references documents(id),
  order_id     uuid not null references orders(id),
  signer_id    uuid not null references users(id),
  provider     text not null,
  digest       text not null check (digest ~ '^[0-9a-f]{64}$'),
  storage_key  text not null unique,
  size_bytes   int not null check (size_bytes > 0),
  certificate  jsonb not null,
  test         boolean not null,
  signed_at    timestamptz not null default now(),
  checked_at   timestamptz not null default now(),
  checked_ok   boolean not null
);
create index document_signatures_order on document_signatures(order_id);
