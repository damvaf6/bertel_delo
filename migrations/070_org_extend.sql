-- 070 · Просьба о переносе срока от организации (задача 2.221): эксперт просит передать дело, а передать некому —
-- руководитель сам просит диспетчера перенести срок от организации. Здесь — от какой организации просьба (у просьбы
-- исполнителя пусто) и новый исход просьбы передать дело: 'extend' — руководитель попросил перенос вместо передачи.
alter table deadline_requests add column org_id uuid references organizations(id);
alter table handover_requests drop constraint handover_requests_outcome_check;
alter table handover_requests add constraint handover_requests_outcome_check
  check (outcome in ('transferred', 'declined', 'withdrawn', 'extend'));
alter table handover_requests add column extend_id bigint references deadline_requests(id);
