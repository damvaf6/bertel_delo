-- 075 · «Пока Вас не было» (задача 2.239): эксперт вернулся после дней «не принимаю дела» — в первый день одно уведомление,
-- что произошло с его делами (src/notify/away.mjs). away_since — первый день «не принимаю» (away_from или день, когда
-- поставил отметку «с сегодня»): с него считаются события. away_back_for — для какого away_until сводка уже ушла.
alter table specialists add column away_since date, add column away_back_for date;
