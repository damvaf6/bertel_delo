-- 094 · Утренняя сводка эксперта: сколько дел со сроком в новогодние каникулы (прогон 2.400, как у руководителя — 093).
alter table morning_digests add column new_year int not null default 0;
