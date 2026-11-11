-- 114 · «Ваш эксперт» и «Принять» (2.465, схема 5 экранов — решение Дамира 31.10/02.11.2026): заказчик видит карточку
-- эксперта, взявшего дело, и нажимает «Принять» — согласие с условиями заказа (офертой) с этим экспертом. Запись — на пару
-- «заявка — эксперт»: дело передали другому эксперту — новый эксперт принимается заново, прежняя запись остаётся историей.
create table expert_accepts (
  order_id          uuid not null references orders(id),
  executor_user_id  uuid not null references users(id),
  user_id           uuid not null references users(id),
  offer_version     text not null check (offer_version ~ '^\d{4}-\d{2}-\d{2}$'),
  at                timestamptz not null default now(),
  primary key (order_id, executor_user_id)
);
