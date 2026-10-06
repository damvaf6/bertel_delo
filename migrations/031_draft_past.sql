-- 031 · Черновик по своему прошлому делу (задача 2.65): версия черновика, в которую эксперт взял методические разделы
-- (стандарты, допущения, выбор подходов, методика) из своего прошлого черновика той же услуги — источник 'past'.
alter table result_drafts drop constraint result_drafts_source_check;
alter table result_drafts add constraint result_drafts_source_check check (source in ('ai', 'edit', 'past'));
