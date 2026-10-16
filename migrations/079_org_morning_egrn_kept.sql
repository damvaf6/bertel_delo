-- 079 · Утренняя сводка руководителя: в скольких делах на подписи после возврата расхождение с выпиской ЕГРН осталось (задача 2.257).
alter table org_morning_digests add column egrn_kept int not null default 0;
