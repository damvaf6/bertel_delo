-- 043 · Просьба эксперта передать дело коллеге (задача 2.107): эксперт, работающий от организации, просит руководителя
-- передать дело в работе другому эксперту (отпуск, болезнь) с причиной; руководитель передаёт (как в 2.62) или отказывает.
-- Записи остаются — история просьб. Открытая просьба на дело одна.
create table handover_requests (
  id            bigserial primary key,
  order_id      uuid not null references orders(id),
  org_id        uuid not null references organizations(id),
  requested_by  uuid not null references users(id),
  reason        text not null,
  requested_at  timestamptz not null default now(),
  outcome       text check (outcome in ('transferred', 'declined', 'withdrawn')),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  answer        text,
  to_user       uuid references users(id)
);
create index handover_requests_order on handover_requests (order_id);
create unique index handover_requests_open on handover_requests (order_id) where outcome is null;
