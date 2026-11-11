-- 115 · Отзыв заказчика (2.467, схема 5 экранов — решение Дамира 31.10/02.11.2026): после выдачи результата заказчик ставит
-- оценку 1–5 и пишет пару слов. Видят диспетчер и руководитель организации эксперта (ЦНЭР); учитывается в подборе
-- («качество»). Один отзыв на заявку — об эксперте, который сдал результат. Эксперту и на витрине — позже.
create table order_reviews (
  order_id          uuid primary key references orders(id),
  executor_user_id  uuid not null references users(id),
  user_id           uuid not null references users(id),
  rating            smallint not null check (rating between 1 and 5),
  text              text check (text is null or char_length(text) <= 500),
  at                timestamptz not null default now()
);
create index order_reviews_executor on order_reviews (executor_user_id, at desc);
