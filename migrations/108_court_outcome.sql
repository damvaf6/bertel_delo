-- 108 · «Как прошло» (задача 2.447): после заседания эксперт отмечает итог — пояснения даны, заседание отложено (новая дата —
-- новым вызовом: его записывает эксперт, кто сообщил о вызове — прежний), назначена повторная или дополнительная экспертиза. Заметка — по желанию.
-- Итог можно поправить; отложенное заседание с уже записанным новым — только сменой даты нового.
alter table court_calls add column outcome_kind text check (outcome_kind in ('explained', 'postponed', 'repeat', 'extra'));
alter table court_calls add column outcome_note text;
alter table court_calls add column outcome_at timestamptz;
alter table court_calls add column outcome_by uuid references users(id);
alter table court_calls add column next_call_id bigint references court_calls(id);
alter table court_calls add constraint court_calls_outcome check ((outcome_kind is null) = (outcome_at is null)
  and (next_call_id is null or outcome_kind = 'postponed'));
