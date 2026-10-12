// Расчёты модуля, которые нельзя описать данными (задача штаба 3f617197): предварительная цена по таблице цен,
// предупреждения к заявке и то, что нельзя заказать. Ядро вызывает их по id модуля; у модуля без расчётов — пусто.
// Цены и правила, которые правит администратор (2а.9), — настройки модуля: refresh перечитывает их из базы, proofread —
// действующие числа вычитки поверх описания модуля.
import { currentRules, quoteTranslation, translationNotices, translationSubmitProblems } from '../translation/prices.mjs';
import { refreshTranslationSettings, resetTranslationSettings } from '../translation/settings.mjs';

const EXTRAS = {
  translation: {
    quote: quoteTranslation, notices: translationNotices, submitProblems: translationSubmitProblems,
    refresh: refreshTranslationSettings, reset: resetTranslationSettings,
    proofread: () => { const r = currentRules(); return { new_orders: r.proofread_new_orders, sample_percent: r.proofread_sample_percent, redo_days: r.redo_days }; },
  },
};

// Предварительная цена по таблице цен модуля: { lines, total_kop, … } или null.
export const moduleQuote = (order) => EXTRAS[order.module]?.quote(order.service, order.fields ?? {}) ?? null;
// Предупреждения к заявке: [{ id, text }].
export const moduleNotices = (order) => EXTRAS[order.module]?.notices(order.service, order.fields ?? {}) ?? [];
// Что в заявке нельзя заказать (не хватает для отправки).
export const moduleSubmitProblems = (order) => EXTRAS[order.module]?.submitProblems(order.service, order.fields ?? {}) ?? [];
// Настройки модулей: перечитать из базы, если пора (перед каждой операцией), и сбросить при сборке приложения.
export const refreshModuleSettings = (sql) => Promise.all(Object.values(EXTRAS).map((x) => x.refresh?.(sql)));
export const resetModuleSettings = () => Object.values(EXTRAS).forEach((x) => x.reset?.());
// Действующие числа вычитки модуля (поверх описания) или {}.
export const moduleProofread = (moduleId) => EXTRAS[moduleId]?.proofread?.() ?? {};
