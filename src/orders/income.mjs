// Доходный подход у нежилого помещения (2.521). Стоимость считают от арендной платы: площадь × рыночная ставка аренды за кв. м
// в год = потенциальный валовой доход (ПВД); минус недозагрузка и потери — действительный валовой доход (ДВД); минус
// операционные расходы — чистый операционный доход (ЧОД); ЧОД / ставка капитализации — стоимость. Таблица «Расчёт доходным
// подходом» встаёт в конец раздела черновика с income: true («13. Доходный подход»); суммы считает эксперт — «[заполнить]».
// Программа знает из заявки площадь и фактическую плату по договору аренды (для сравнения с рынком). Прежняя таблица узнаётся
// по строке заголовка и заменяется целиком; из черновика — в Word.
import { placeShare } from './share.mjs';

export const INCOME_HEAD = '| Расчёт доходным подходом | Значение |';
const GAP = '[заполнить]';
const LEASED = ['full', 'part'];
const NUM = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const num = (n) => NUM.format(n).replace(/\s/g, ' ');

export function incomeTable(serviceId, fields = {}) {
  if (serviceId !== 'realty' || fields.object_type !== 'commercial') return null;
  const area = Number(fields.area);
  const rent = Number(fields.lease_rent);
  const rows = [
    INCOME_HEAD,
    `| Площадь помещения, кв. м | ${Number.isFinite(area) && area > 0 ? `${num(area)} (по заявке — сверьте с выпиской ЕГРН)` : GAP} |`,
  ];
  if (LEASED.includes(fields.lease) && Number.isFinite(rent) && rent > 0) {
    rows.push(`| Арендная плата по договору, руб. в месяц | ${num(rent)} (по заявке — сравните с рыночной ставкой) |`);
  }
  rows.push(
    `| Рыночная ставка аренды, руб. за кв. м в год | ${GAP} (аналоги аренды или источник — ${GAP}) |`,
    `| Потенциальный валовой доход (площадь × ставка), руб. в год | ${GAP} |`,
    `| Недозагрузка и потери при сборе платежей, % | ${GAP} (источник — ${GAP}) |`,
    `| Действительный валовой доход (ПВД × (1 − недозагрузка)), руб. в год | ${GAP} |`,
    `| Операционные расходы, руб. в год | ${GAP} (из чего состоят — ${GAP}) |`,
    `| Чистый операционный доход (ДВД − расходы), руб. в год | ${GAP} |`,
    `| Ставка капитализации, % | ${GAP} (источник — ${GAP}) |`,
    `| Стоимость доходным подходом (ЧОД / ставка), руб. | ${GAP} |`,
  );
  return rows;
}

export function placeIncome(body, sections, lines) {
  return placeShare(body, sections, lines, 'income');
}

// Ставка капитализации и стоимость доходным подходом из черновика (2.527, сводка руководителя): строки таблицы «Расчёт доходным
// подходом» (или текста) — число в ячейке значения; пропуск «[заполнить]» или строки нет — null. Строка без числа — ищем дальше.
const CAP_LINE = /(?:ставк\S*|коэффициент\S*)\s+капитализаци\S*/iu;
const VALUE_LINE = /стоимост\S*\s+(?:объекта\s+(?:оценки\s+)?)?(?:доходн\S*\s+подход\S*|по\s+доходному\s+подходу)/iu;
function cellNum(body, re) {
  for (const line of String(body ?? '').split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const rest = line.slice(m.index + m[0].length)
      .replace(/^\s*\((?:[^()]|\([^()]*\))*\)/u, '')
      .replace(/^\s*,?\s*(?:руб\.?|%)/u, '')
      .split('[')[0];
    const n = /(?<![\d])(\d{1,3}(?:[\s  ]\d{3})+|\d+)(?:[,.](\d+))?(?![\d/])/u.exec(rest);
    if (n) return Number(n[1].replace(/[\s  ]/gu, '')) + (n[2] ? Number(`0.${n[2]}`) : 0);
  }
  return null;
}
// { cap: ставка капитализации, % (0 < x < 100, иначе null), value: стоимость доходным подходом, руб. (> 0, иначе null) }.
export function incomeFacts(body) {
  const cap = cellNum(body, CAP_LINE);
  const value = cellNum(body, VALUE_LINE);
  return { cap: cap > 0 && cap < 100 ? cap : null, value: value > 0 ? value : null };
}
