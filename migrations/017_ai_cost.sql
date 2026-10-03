-- Расход на модель ИИ (решение Дамира 03.10.2026: настоящий YandexGPT на площадке — не больше 1 000 ₽ в месяц).
-- У каждого обращения — сколько токенов ушло и сколько это стоило (в копейках, по цене из настроек). Сумма за месяц
-- сверяется с пределом AI_BUDGET_RUB до обращения к модели.
alter table ai_usage add column tokens integer not null default 0 check (tokens >= 0);
alter table ai_usage add column cost_kop integer not null default 0 check (cost_kop >= 0);
create index ai_usage_at on ai_usage(at desc);
