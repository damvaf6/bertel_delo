-- 014 · Экспресс-услуга (задача 2.4). Заказчик выбирает экспресс: на объект выезжает помощник платформы, эксперт работает
-- дистанционно. Помощник (специалист с отметкой «выезды») снимает объект по тем же шагам, что и дистанционный осмотр (2.3),
-- и заполняет данные с объекта из описания модуля. Фото — документы заявки вида «осмотр», данные — в выезде.

alter table orders add column express boolean not null default false;

-- Помощник на объекте: отметку ставит администратор; районы выездов — те же, что у специалиста.
alter table specialists add column onsite boolean not null default false;

-- Выезд: кого и на когда назначил исполнитель. Действует, пока не отменён и не завершён, а дело в работе у того,
-- кто назначил. У заявки один открытый выезд за раз.
create table onsite_visits (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references orders(id),
  helper_id    uuid not null references users(id),
  assigned_by  uuid not null references users(id),
  planned_at   timestamptz not null,
  data         jsonb not null default '{}',
  finished_at  timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now()
);
create index onsite_visits_order on onsite_visits(order_id, id desc);
create index onsite_visits_helper on onsite_visits(helper_id, id desc);
create unique index onsite_visits_open on onsite_visits(order_id) where finished_at is null and cancelled_at is null;

-- Фото осмотра приходят либо по ссылке владельца (2.3), либо от помощника на выезде.
alter table inspection_photos alter column link_id drop not null;
alter table inspection_photos add column visit_id bigint references onsite_visits(id);
alter table inspection_photos add constraint inspection_photos_source check ((link_id is null) <> (visit_id is null));
create index inspection_photos_visit on inspection_photos(visit_id) where visit_id is not null;
