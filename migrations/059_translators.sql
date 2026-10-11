-- 059 · Исполнители-переводчики (задача 2а.3, задачи штаба 3f617197 и 3f417197-…-813c).
-- Статус исполнителя: самозанятый, ИП, ООО или бюро. Физическое лицо без статуса к переводам не допускается — иначе
-- платформа становится налоговым агентом. null — статус не указан (у экспертов — как раньше).
alter table specialists add column tax_status text check (tax_status in ('self_employed', 'ip', 'company'));
-- Документ о знании языка — в досье, по каждому языку; к нотариальным переводам — только проверенный администратором.
-- Новые сведения или новая копия снимают отметку о проверке.
alter table dossier_items drop constraint dossier_items_kind_check;
alter table dossier_items add constraint dossier_items_kind_check
  check (kind in ('education', 'certificate', 'sro', 'policy', 'policy_org', 'language'));
alter table dossier_items add column language text check (length(language) between 1 and 20),
  add column verified_at timestamptz, add column verified_by uuid references users(id);
alter table dossier_items add constraint dossier_items_language_kind check ((kind = 'language') = (language is not null));
-- Чек самозанятого на выплату («Мой налог»): ссылка на чек и когда приложен.
alter table payouts add column receipt_url text check (length(receipt_url) <= 300), add column receipt_at timestamptz;
