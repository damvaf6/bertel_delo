-- 016 · Подпись результата по решению Дамира 03.10.2026 (задача 2.5а): все способы подписи и двое подписывающих.
-- Способ (method): 'cabinet' — подпись в кабинете через поставщика подписи; 'upload' — человек загрузил готовый файл
-- открепленной подписи из программы удостоверяющего центра или «Госключа».
-- Кто (role): 'expert' — эксперт, выполнивший работу; 'org' — организация, от которой он работает (подписывает руководитель).
-- На один файл — не больше одной подписи каждого вида. Прежние подписи (2.5) — подписи эксперта в кабинете.
alter table document_signatures add column role text not null default 'expert' check (role in ('expert', 'org'));
alter table document_signatures add column method text not null default 'cabinet' check (method in ('cabinet', 'upload'));
alter table document_signatures add column org_id uuid references organizations(id);
alter table document_signatures add constraint document_signatures_org_role check ((role = 'org') = (org_id is not null));
alter table document_signatures drop constraint document_signatures_document_id_key;
alter table document_signatures add constraint document_signatures_document_role unique (document_id, role);

-- Организация, от которой специалист работает (выбирает сам из своих организаций). Если она указана и специалист в ней
-- состоит, результат подписывает ещё и её руководитель. Без организации (частная практика) — только подпись эксперта.
alter table specialists add column org_id uuid references organizations(id);
