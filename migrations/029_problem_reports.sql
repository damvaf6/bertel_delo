-- 029 · «Сообщить о проблеме» (задача 2.54): журнал сообщений из кабинета на закрытом запуске. Что случилось (словами
-- человека), где (раздел кабинета), какой экран и браузер; разбирает диспетчер или администратор — отметка и заметка.
create table problem_reports (
  id         bigserial primary key,
  user_id    uuid not null references users(id),
  body       text not null check (length(body) between 1 and 2000),
  place      text not null default '' check (length(place) <= 60),
  client     text not null default '' check (length(client) <= 300),
  created_at timestamptz not null default now(),
  closed_at  timestamptz,
  closed_by  uuid references users(id),
  note       text check (length(note) <= 1000)
);
create index problem_reports_open on problem_reports (created_at desc) where closed_at is null;
