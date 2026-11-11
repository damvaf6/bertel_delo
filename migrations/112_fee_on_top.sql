-- 112 · Комиссия платформы сверх цены эксперта (2.463, схема 5 экранов — решение Дамира 31.10/02.11.2026): диспетчер
-- назначает цену эксперта, заказчик платит её ×1,2, эксперт получает 100% своей цены. expert_kop — снимок цены эксперта на
-- момент назначения цены (у заявок до 2.463 и у переводов — пусто: прежнее 80/20 из цены заказчика).
-- payout_manual — выплата по заявке идёт вручную (списком, отметку ставит диспетчер), а не через поставщика оплаты.
alter table orders add column expert_kop bigint check (expert_kop > 0);
alter table orders add column payout_manual boolean not null default false;
-- Выплата вручную: не уходит поставщику; диспетчер отмечает «выплачено» с пометкой (номер платёжки и т.п.).
alter table payouts add column manual boolean not null default false;
alter table payouts add column manual_note text check (length(manual_note) <= 200);
alter table payouts add column marked_by uuid references users(id);
