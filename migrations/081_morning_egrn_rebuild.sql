-- 081 · Утренняя сводка эксперта: в скольких делах он заменил по выписке ЕГРН в черновике, а файл результата собран до
-- замены — «соберите Word заново» (задача 2.272).
alter table morning_digests add column egrn_rebuild int not null default 0;
