-- 069 · Карточка допуска исполнителя (задача штаба 3f817197-…-81b2). Выдаёт администратор платформы: номер, срок действия,
-- уровни проверки, код для открытой страницы проверки (QR). Отзыв — с причиной: на странице проверки видна только общая
-- причина (revoke_reason), пояснение администратора (revoke_note) — только платформе. Отозванная карточка снимает
-- исполнителя с подбора, пока не выдана новая. Ключи подписи платформа не хранит: уровень «подпись КЭП проверена» берётся
-- из отметки сотрудника после проверки на Госуслугах (миграция 068).
-- docs_checked — администратор сверил документы об образовании и квалификации (по копиям в досье).
create sequence permit_card_seq;
create table permit_cards (
  id            bigint generated always as identity primary key,
  number        text not null unique,
  code          text not null unique check (code ~ '^[A-Z2-9]{12}$'),
  user_id       uuid not null references specialists(user_id),
  full_name     text not null check (length(full_name) between 1 and 200),
  valid_until   date not null,
  docs_checked  boolean not null default false,
  issued_by     uuid not null references users(id),
  issued_at     timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid references users(id),
  revoke_reason text check (revoke_reason in ('request', 'documents', 'rules', 'other')),
  revoke_note   text check (length(revoke_note) <= 500),
  constraint permit_cards_revoked check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null))
);
-- Действующая (не отозванная) карточка у исполнителя одна.
create unique index permit_cards_active on permit_cards(user_id) where revoked_at is null;
create index permit_cards_user on permit_cards(user_id, issued_at desc);
