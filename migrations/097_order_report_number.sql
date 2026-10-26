-- 097 · Свой номер отчёта эксперта, выданный делу при первой сборке Word по образцу (задача 2.412). Повторная сборка —
-- тот же номер; by — кому выдан (после передачи дела другому эксперту выдаётся заново по его образцу).
alter table orders add column report_number text;
alter table orders add column report_number_on date;
alter table orders add column report_number_by uuid references users(id);
create index orders_report_number_by on orders (report_number_by, report_number_on) where report_number is not null;
