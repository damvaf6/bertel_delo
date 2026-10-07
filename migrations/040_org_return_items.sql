-- 040 · Замечания руководителя по пунктам (задача 2.93): при возврате отчёта эксперту (2.27) каждая строка замечания —
-- отдельный пункт. Эксперт отмечает исправленные, руководитель до новой подписи видит, что осталось. Текст возврата целиком
-- по-прежнему в org_returns.comment.
create table org_return_items (
  return_id  bigint not null references org_returns(id),
  n          int not null,
  text       text not null,
  fixed_at   timestamptz,
  fixed_by   uuid references users(id),
  primary key (return_id, n)
);
