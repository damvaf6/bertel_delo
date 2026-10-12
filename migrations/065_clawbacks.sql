-- 065 · Возврат за перевод после выплаты переводчику (решение Дамира 12.10.2026, задача 2а.11). Дело после бесплатной
-- переделки (или выданное) диспетчер может отменить с возвратом заказчику. Если проверка признала перевод плохим —
-- выплаченное переводчику удерживается из его следующих выплат (долг — clawbacks); если перевод нормальный, а заказчик
-- просто недоволен — возврат за счёт платформы, у переводчика не удерживается.

-- Чем признан перевод при такой отмене: bad — плохой (удержание у переводчика), ok — нормальный (за счёт платформы).
alter table orders add column refund_quality text check (refund_quality is null or refund_quality in ('bad', 'ok'));

-- Возврат после выплаты исполнителю: деньги уже не лежат у платформы — для сводки «деньги у платформы».
alter table refunds add column after_payout boolean not null default false;

-- Долг исполнителя перед платформой: выплаченное по заявке, перевод признан плохим. Гасится из следующих выплат.
create table clawbacks (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null unique references orders(id),
  executor_user_id uuid not null references users(id),
  amount_kop       bigint not null check (amount_kop > 0),
  withheld_kop     bigint not null default 0 check (withheld_kop >= 0 and withheld_kop <= amount_kop),
  reason           text check (length(reason) <= 1000),
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);
create index clawbacks_open on clawbacks(executor_user_id, created_at) where closed_at is null;

-- Сколько из выплаты удержано в счёт долга; выплата может уйти в ноль, если долг больше.
alter table payouts add column withheld_kop bigint not null default 0 check (withheld_kop >= 0);
alter table payouts drop constraint payouts_amount_kop_check;
alter table payouts add constraint payouts_amount_kop_check check (amount_kop >= 0);
