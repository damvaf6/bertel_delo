// Нежилое помещение (2.519). У оценки недвижимости «Нежилое помещение» — офис, магазин, склад; главное отличие от квартиры —
// доходный подход: помещение сдаётся или может сдаваться, и его стоимость считают ещё и от арендной платы. Заказчик в заявке
// пишет назначение, сдаётся ли помещение и за сколько, какой вход; здесь — подсказка в деле всем, кто видит заявку. О
// договоре аренды как о сделке (законен ли, кто прав) не пишем — это вопрос юриста, не оценщика.

const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rub = (n) => `${RUB.format(n).replace(/\s/g, ' ')} руб.`;
const FILLED = ['premises_use', 'lease', 'lease_rent', 'entrance'];
const LEASED = { full: 'сдаётся целиком', part: 'сдаётся частично' };

export function premisesNotices(serviceId, fields = {}) {
  if (serviceId !== 'realty') return [];
  const has = (id) => fields[id] !== undefined && fields[id] !== null && fields[id] !== '';
  if (fields.object_type !== 'commercial') {
    return FILLED.some(has)
      ? [{ id: 'premises_type', text: 'В заявке есть сведения о нежилом помещении (назначение, аренда или вход), а оценивается не нежилое помещение — проверьте «Что оцениваем».' }]
      : [];
  }
  const out = [];
  const rent = Number(fields.lease_rent);
  const withRent = has('lease_rent') && Number.isFinite(rent) && rent > 0;
  if (LEASED[fields.lease]) {
    const how = `Помещение ${LEASED[fields.lease]}${withRent ? `, арендная плата — ${rub(rent)} в месяц` : ''}`;
    out.push({ id: 'premises_lease', text: `${how}: в отчёте — доходный подход по рыночной ставке аренды (фактическую плату по договору сравните с рынком), аренда — обременение, назовите её в описании объекта. Договор аренды — в документы дела.` });
    if (!withRent) out.push({ id: 'premises_rent', text: 'Не указана арендная плата по договору — уточните у заказчика или возьмите из договора аренды.' });
  } else if (fields.lease === 'no') {
    if (withRent) out.push({ id: 'premises_rent', text: `Указана арендная плата ${rub(rent)} в месяц, а помещение «не сдаётся» — уточните у заказчика.` });
    else out.push({ id: 'premises_free', text: 'Помещение не сдаётся: доходный подход — по рыночной ставке аренды похожих помещений (аналоги аренды) или обоснованный отказ от него.' });
  } else {
    out.push({ id: 'premises_ask', text: 'Не указано, сдаётся ли помещение в аренду: от этого зависит доходный подход и нужен ли договор аренды. Уточните у заказчика.' });
  }
  return out;
}
