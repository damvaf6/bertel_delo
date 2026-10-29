-- 103 · «Ответ на замечания» Word (задача 2.433): у пункта замечаний — где в отчёте исправлено или пояснено (раздел, страница);
-- ответ, приложенный к исправленному отчёту файлом результата, — у дела (по последнему кругу замечаний).
alter table remark_items add column place text;
alter table orders add column remarks_answer_doc_id uuid references documents(id);
