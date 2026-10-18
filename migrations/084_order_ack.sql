-- 084 · Ответ заказчику сразу после отправки заявки (задача штаба 3fd17197): обещанное время первого ответа (снимок настройки
-- модуля при отправке, src/orders/ack.mjs) и когда заказчику ушло «задерживаемся» (один раз). Настройка часов по модулям —
-- module_settings, module 'order_ack' (история изменений там же). Нет числа у модуля — ack_due_at пусто, ответа со сроком нет.
alter table orders add column ack_due_at timestamptz, add column ack_late_at timestamptz;
create index orders_ack_due on orders (ack_due_at) where ack_due_at is not null and ack_late_at is null;
