-- Распределение внутри организации (2.17): диспетчер предлагает дело организации, эксперта из своих назначает руководитель.
-- orders.offer_org_id — организация, у которой дело сейчас (пока ждёт исполнителя); после принятия остаётся для истории.
alter table orders add column offer_org_id uuid references organizations(id);
create index orders_offer_org on orders(offer_org_id) where offer_org_id is not null;

-- Предложение организации — строка без специалиста; предложение эксперту от руководителя — с организацией и специалистом.
alter table order_offers alter column specialist_id drop not null;
alter table order_offers add column org_id uuid references organizations(id);
alter table order_offers add constraint order_offers_target check (specialist_id is not null or org_id is not null);
create index order_offers_org on order_offers(org_id, id) where org_id is not null;
