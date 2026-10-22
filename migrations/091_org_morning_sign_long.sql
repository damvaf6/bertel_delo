-- 091 · Утренняя сводка руководителя: сколько дел ждут подписи организации 2 дня и дольше (задача 2.374).
alter table org_morning_digests add column sign_long int not null default 0;
