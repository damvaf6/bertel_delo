// Расчёты модуля, которые нельзя описать данными (задача штаба 3f617197): предварительная цена по таблице цен,
// предупреждения к заявке и то, что нельзя заказать. Ядро вызывает их по id модуля; у модуля без расчётов — пусто.
import { quoteTranslation, translationNotices, translationSubmitProblems } from '../translation/prices.mjs';

const EXTRAS = {
  translation: { quote: quoteTranslation, notices: translationNotices, submitProblems: translationSubmitProblems },
};

// Предварительная цена по таблице цен модуля: { lines, total_kop, … } или null.
export const moduleQuote = (order) => EXTRAS[order.module]?.quote(order.service, order.fields ?? {}) ?? null;
// Предупреждения к заявке: [{ id, text }].
export const moduleNotices = (order) => EXTRAS[order.module]?.notices(order.service, order.fields ?? {}) ?? [];
// Что в заявке нельзя заказать (не хватает для отправки).
export const moduleSubmitProblems = (order) => EXTRAS[order.module]?.submitProblems(order.service, order.fields ?? {}) ?? [];
