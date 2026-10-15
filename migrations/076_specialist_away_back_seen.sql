-- 076 · «Пока Вас не было»: «Всё посмотрел» (задача 2.244). away_back_seen — для какого away_until эксперт убрал блок;
-- новые дни «не принимаю дела» — новый away_until, блок снова виден.
alter table specialists add column away_back_seen date;
