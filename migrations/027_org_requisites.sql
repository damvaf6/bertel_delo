-- 027 · Деньги для юрлица (задача 2.46): реквизиты организации-заказчика для счёта и акта — КПП и юридический адрес
-- (ИНН — с 002). Необязательные: без них счёт и акт выходят с названием и ИНН.
alter table organizations
  add column kpp           text check (kpp ~ '^\d{9}$'),
  add column legal_address text check (length(legal_address) between 1 and 500);
