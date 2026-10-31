-- 111 · Срок аккредитации организации в банке кончается (2.454): напоминания руководителям и экспертам организации за 30 и
-- за 7 дней и при истёкшем — каждое один раз на запись, вид и срок (как dossier_reminders у досье); новый срок — снова.
create table org_accreditation_reminders (
  item_id     bigint not null references org_accreditations(id),
  kind        text not null check (kind in ('d30', 'd7', 'expired')),
  valid_until date not null,
  at          timestamptz not null default now(),
  primary key (item_id, kind, valid_until)
);
