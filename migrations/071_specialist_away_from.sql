-- 071 · Дни «не принимаю дела» с заданного дня (задача 2.226): away_from — первый такой день (null — с сегодня, как раньше);
-- до него подбор эксперта предлагает. away_warned_from — для какого away_from уже ушло предупреждение «за 3 дня до начала:
-- срок дел в эти дни» (src/notify/away.mjs); эксперт сдвинул начало — предупреждение придёт по новому дню.
alter table specialists add column away_from date, add column away_warned_from date;
