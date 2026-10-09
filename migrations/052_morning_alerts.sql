-- 052 · Утренняя сводка эксперту (задача 2.142): сколько дел «срок близко — нет файла результата» (2.138) и «заказчик ждёт
-- ответа» (2.132). Только числа.
alter table morning_digests add column no_result int not null default 0, add column reply_wait int not null default 0;
