-- 098 · Нумерация отчётов организации (задача 2.415): один образец и общий счёт за год для всех экспертов, которые работают
-- от организации. orders.report_number_org — по счёту какой организации выдан номер делу (null — по образцу самого эксперта).
alter table organizations add column report_pattern text;
alter table orders add column report_number_org uuid references organizations(id);
create index orders_report_number_org on orders (report_number_org, report_number_on) where report_number is not null;
