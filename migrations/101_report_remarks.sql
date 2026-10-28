-- 101 · Замечания к сданному отчёту (задача 2.431): после «готово» заказчик пишет, что пришли замечания от банка или суда, и
-- прикладывает файл замечаний; дело снова у эксперта, срок ответа — рабочие дни из описания модуля (remarks.reply_days).
-- Последние замечания — здесь; текст каждого раза — в истории статусов (reason), круг — сколько раз приходили.
alter table orders add column remarks_at timestamptz, add column remarks_due date,
  add column remarks_doc_id uuid references documents(id), add column remarks_round int not null default 0;
