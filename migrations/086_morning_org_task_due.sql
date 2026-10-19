-- 086 · Утренняя сводка руководителя: в скольких делах на подписи организации срок по заданию на оценку сегодня или прошёл
-- (задача 2.316).
alter table org_morning_digests add column task_due int not null default 0;
