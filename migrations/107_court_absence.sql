-- 107 · «Не смогу прийти» (задача 2.445): эксперт подаёт ходатайство к заседанию — рассмотреть без его участия или
-- отложить; причина обязательна. Из этого — Word ходатайства, заказчику — уведомление. Одно ходатайство на заседание:
-- подал заново — прежнее заменяется (видно в журнале действий).
alter table court_calls add column absence_kind text check (absence_kind in ('without', 'postpone'));
alter table court_calls add column absence_reason text;
alter table court_calls add column absence_at timestamptz;
alter table court_calls add constraint court_calls_absence check ((absence_kind is null) = (absence_reason is null) and (absence_kind is null) = (absence_at is null));
