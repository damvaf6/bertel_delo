-- 024 · Осмотр: ссылка владельцу СМС с платформы и просьба переснять шаг (задача 2.20).
-- Номер владельца не хранится: СМС уходит сразу при выдаче ссылки (секрет ссылки в базу не попадает), в ссылке — только
-- скрытый номер («+7 *** ***-12-34»), чтобы эксперт видел, куда ушло.
alter table inspection_links add column sms_to text, add column sms_sent_at timestamptz;

-- Просьба переснять шаг: эксперт пишет, что не так; владелец видит её у шага, пока не пришлёт новое фото этого шага
-- (closed_reason = 'photo') или эксперт не отменит её ('cancelled'). Открытая просьба по шагу — одна.
create table inspection_retakes (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references orders(id),
  step          text not null,
  note          text not null check (length(note) between 1 and 300),
  requested_by  uuid not null references users(id),
  requested_at  timestamptz not null default now(),
  closed_at     timestamptz,
  closed_reason text check (closed_reason in ('photo', 'cancelled')),
  check ((closed_at is null) = (closed_reason is null))
);
create unique index inspection_retakes_open on inspection_retakes(order_id, step) where closed_at is null;
