-- 083 · Утренняя сводка руководителя: в скольких делах на подписи остались расхождения с заявкой или заданием на оценку (задача 2.286).
alter table org_morning_digests add column order_diff int not null default 0;
