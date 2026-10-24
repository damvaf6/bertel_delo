// Нерабочие праздничные дни РФ (2.371): «Мои сроки на две недели», нагрузка экспертов у руководителя, готовый новый срок
// при просьбе о переносе — праздник не будний день. Праздники — ст. 112 ТК РФ; праздник в субботу или воскресенье (кроме
// новогодних) переносит выходной на следующий рабочий день — так же по закону. Переносы новогодних выходных — постановлением
// Правительства на каждый год (`DECREE`); вышло новое — дописать строку. Рабочие субботы по переносу — `WORKING`.
const FIXED = [
  ['01-01', 'Новогодние каникулы'], ['01-02', 'Новогодние каникулы'], ['01-03', 'Новогодние каникулы'],
  ['01-04', 'Новогодние каникулы'], ['01-05', 'Новогодние каникулы'], ['01-06', 'Новогодние каникулы'],
  ['01-07', 'Рождество Христово'], ['01-08', 'Новогодние каникулы'],
  ['02-23', 'День защитника Отечества'], ['03-08', 'Международный женский день'], ['05-01', 'Праздник Весны и Труда'],
  ['05-09', 'День Победы'], ['06-12', 'День России'], ['11-04', 'День народного единства'],
];
// 2026: выходные 3 и 4 января перенесены на 9 января и 31 декабря.
// 2027 (постановление Правительства от 17.09.2026 № 1187, 2.391): выходные 2 и 3 января — на 5 ноября и 31 декабря,
// суббота 20 февраля — на понедельник 22 февраля (20 февраля — рабочая суббота).
const DECREE = {
  2026: { '2026-01-09': 'Новогодние каникулы', '2026-12-31': 'перенос выходного с 4 января' },
  2027: { '2027-02-22': 'перенос выходного с 20 февраля', '2027-11-05': 'перенос выходного с 2 января',
    '2027-12-31': 'перенос выходного с 3 января' },
};
const WORKING = new Set(['2027-02-20']);

const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const plus = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const years = new Map();
function yearHolidays(y) {
  if (years.has(y)) return years.get(y);
  const map = new Map(FIXED.map(([md, name]) => [`${y}-${md}`, name]));
  for (const [md, name] of FIXED) {
    const iso = `${y}-${md}`;
    if (md.startsWith('01-') || ![0, 6].includes(dow(iso))) continue;
    let d = plus(iso, 1);
    while ([0, 6].includes(dow(d)) || map.has(d)) d = plus(d, 1);
    map.set(d, `перенос выходного за «${name}»`);
  }
  for (const [iso, name] of Object.entries(DECREE[y] ?? {})) map.set(iso, name);
  years.set(y, map);
  return map;
}

// Название праздника или null: '2026-06-12' → 'День России'.
export function holidayName(iso) {
  const day = String(iso).slice(0, 10);
  return yearHolidays(Number(day.slice(0, 4))).get(day) ?? null;
}
export const isWorkday = (iso) => WORKING.has(String(iso).slice(0, 10)) || (![0, 6].includes(dow(iso)) && !holidayName(iso));
// Рабочая суббота по переносу (2.391): '2027-02-20' → true.
export const isWorkingWeekend = (iso) => WORKING.has(String(iso).slice(0, 10));
// Чем день нерабочий, или null: '2026-11-04' → 'День народного единства', '2026-10-24' → 'суббота'.
const WEEKEND = { 0: 'воскресенье', 6: 'суббота' };
export function offDayName(iso) {
  const day = String(iso).slice(0, 10);
  return isWorkday(day) ? null : (holidayName(day) ?? WEEKEND[dow(day)] ?? 'нерабочий день');
}
// Ближайший рабочий день с этого (включительно) вперёд и последний рабочий день перед этим днём.
export function workdayFrom(iso) { let d = iso; while (!isWorkday(d)) d = plus(d, 1); return d; }
export function workdayBefore(iso) { let d = plus(iso, -1); while (!isWorkday(d)) d = plus(d, -1); return d; }
