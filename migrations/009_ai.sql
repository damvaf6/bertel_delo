-- 009 · ИИ (задача 1.8): вход через проблему, ассистент, ИИ-проверка результата по правилам модуля.
-- ИИ ничего не подаёт и не отправляет сам: он отвечает текстом и подсказками, решения принимает человек.

-- Обращения к модели — для дневного лимита и учёта. Тексты сюда не пишутся.
create table ai_usage (
  id      bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  purpose text not null check (purpose in ('problem', 'assistant', 'review')),
  model   text,
  ok      boolean not null,
  at      timestamptz not null default now()
);
create index ai_usage_user on ai_usage(user_id, at desc);

-- Вход через проблему: человек описал вопрос своими словами, ИИ разъяснил и предложил услугу.
-- Видит только автор. Из разбора можно один раз создать заявку.
create table ai_consultations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  problem    text not null check (length(problem) between 1 and 4000),
  answer     jsonb not null,
  model      text not null,
  order_id   uuid references orders(id),
  created_at timestamptz not null default now()
);
create index ai_consultations_user on ai_consultations(user_id, created_at desc);

-- Память ассистента: раздельная по пользователю и организации (org_id null — личная память).
-- Сообщение о заявке помнит её номер: если доступ к заявке пропал, сообщение больше не показывается и не уходит в модель.
create table assistant_messages (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references users(id),
  org_id   uuid references organizations(id),
  role     text not null check (role in ('user', 'assistant')),
  body     text not null check (length(body) between 1 and 8000),
  order_id uuid references orders(id),
  model    text,
  at       timestamptz not null default now()
);
create index assistant_messages_scope on assistant_messages(user_id, org_id, id desc);

-- ИИ-проверка результата: подсказки по каждому правилу модуля. round — круг проверки, к которому относится
-- (исполнитель перед сдачей проверяет будущий круг). Отметки «в порядке / замечание» по-прежнему ставит человек.
create table ai_reviews (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references orders(id),
  round        int not null check (round >= 1),
  requested_by uuid not null references users(id),
  side         text not null check (side in ('executor', 'dispatcher')),
  model        text not null,
  items        jsonb not null,
  files        jsonb not null,
  at           timestamptz not null default now()
);
create index ai_reviews_order on ai_reviews(order_id, round, id desc);
