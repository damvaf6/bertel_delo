-- 095 · Утренняя сводка руководителя: у скольких экспертов аттестат или полис кончается до 15 января (задача 2.406).
alter table org_morning_digests add column dossier_ny int not null default 0;
