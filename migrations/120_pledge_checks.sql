-- 120 · Проверка в реестре уведомлений о залоге движимого имущества (2.491, «Оценка транспорта»): эксперт отмечает дату
-- проверки и итог — залога нет или есть (номер уведомления и залогодержатель). Одна проверка на дело; строкой — в раздел
-- «7. Описание объекта» черновика; ИИ-проверка сверяет отчёт с ней (правило pledge_match).
create table pledge_checks (
  order_id     uuid primary key references orders(id),
  checked_on   date not null,
  result       text not null check (result in ('none', 'found')),
  notice_no    text not null default '' check (char_length(notice_no) <= 60),
  pledgee      text not null default '' check (char_length(pledgee) <= 300),
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (result = 'none' or (notice_no <> '' and pledgee <> ''))
);
