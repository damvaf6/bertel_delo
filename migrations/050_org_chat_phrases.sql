-- 050 · Свои заготовки фраз руководителя в «Переписке с экспертом» (задача 2.137): частые сообщения эксперту («Посмотрите
-- замечания в подписи, пожалуйста», «Когда будет готово?») — сохранить один раз, вставлять одной кнопкой. Хранятся рядом с
-- заготовками замечаний (042): свои у каждого руководителя в каждой организации; видит и меняет только он сам.
alter table org_remarks add column kind text not null default 'remark' check (kind in ('remark', 'phrase'));
drop index org_remarks_owner;
create index org_remarks_owner on org_remarks (org_id, user_id, kind) where deleted_at is null;
