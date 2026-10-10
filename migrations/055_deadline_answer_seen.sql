-- 055 · Ответ диспетчера на просьбу о переносе срока (задача 2.155): когда исполнитель дела впервые увидел ответ (блок
-- «Срок» в деле). Пока не видел — ответ заметно в «Сроке» и строкой в «Сегодня». Прежние ответы считаются увиденными.
alter table deadline_requests add column seen_at timestamptz;
update deadline_requests set seen_at = decided_at where outcome is not null;
