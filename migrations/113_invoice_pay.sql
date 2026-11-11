-- 113 · Оплата по счёту (2.464, схема 5 экранов — решение Дамира 31.10/02.11.2026): в первом выпуске «Экспертизы» заказчик
-- платит по счёту ООО «АИС Переводчик» по реквизитам, поступление отмечает диспетчер. Картой/СБП — после подключения ЮKassa.
-- method — как оплачено: 'card' (через поставщика оплаты) или 'invoice' (по счёту, отметка диспетчера с пометкой).
alter table payments add column method text not null default 'card' check (method in ('card', 'invoice'));
alter table payments add column note text check (length(note) <= 200);
alter table payments add column marked_by uuid references users(id);
-- Заказчик сообщил «оплатил по счёту» (с пометкой — дата, номер платёжки): диспетчеру — уведомление и строка в «Деньгах».
alter table orders add column invoice_claimed_at timestamptz;
alter table orders add column invoice_claim_note text check (length(invoice_claim_note) <= 200);
-- Возврат по оплате по счёту: поставщику не уходит; диспетчер перечисляет сам и отмечает «возвращено» с пометкой.
alter table refunds add column manual boolean not null default false;
alter table refunds add column manual_note text check (length(manual_note) <= 200);
alter table refunds add column marked_by uuid references users(id);
