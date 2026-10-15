-- 078 · Утренняя сводка руководителя: сколько экспертов сегодня вернулись после дней «не принимаю дела» (задача 2.249).
alter table org_morning_digests add column back int not null default 0;
