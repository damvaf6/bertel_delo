-- 044 · Просьба прежнего эксперта о переносе срока после передачи дела (задача 2.112): новый эксперт решает — оставить её
-- (тогда она уже его, диспетчер отвечает как обычно) или отозвать. Здесь — кто и когда оставил.
alter table deadline_requests add column kept_by uuid references users(id);
alter table deadline_requests add column kept_at timestamptz;
