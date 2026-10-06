-- 032 · Повтор отправки фото осмотра при плохой связи (задача 2.68): страница владельца и помощника помечает каждый снимок
-- своим номером (x-photo-id) и повторяет отправку, пока не дойдёт. Если ответ потерялся, а фото уже дошло, повтор
-- не создаёт второе фото того же снимка.
alter table inspection_photos add column client_id text check (client_id ~ '^[A-Za-z0-9_-]{8,64}$');
create unique index inspection_photos_link_client on inspection_photos(link_id, client_id) where client_id is not null and link_id is not null;
create unique index inspection_photos_visit_client on inspection_photos(visit_id, client_id) where client_id is not null and visit_id is not null;
