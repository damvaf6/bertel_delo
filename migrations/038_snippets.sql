-- 038 · Свои заготовки абзацев у эксперта (задача 2.87): допущения, оговорки, формулировки выводов — вставляются в
-- черновик одной кнопкой. Видит и меняет только сам эксперт; убранная заготовка остаётся в истории (deleted_at).
create table snippets (
  id         bigserial primary key,
  user_id    uuid not null references users(id),
  kind       text not null check (kind in ('assumption', 'reservation', 'conclusion', 'other')),
  title      text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index snippets_user on snippets (user_id) where deleted_at is null;
