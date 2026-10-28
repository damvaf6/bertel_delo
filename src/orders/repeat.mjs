// Повторная оценка того же объекта (2.118): тот ли это объект, что в своём прошлом деле эксперта. Объект узнаётся по полям
// заявки из описания модуля (repeat.match: кадастровый номер и адрес, VIN и госномер): хотя бы одно поле заполнено в обоих
// делах и совпадает, и ни одно заполненное в обоих — не расходится. Адрес сравнивается без «г.», «ул.», «д.», знаков и
// регистра: «г. Москва, ул. Ленина, д. 5, кв. 12» и «Москва, Ленина 5, кв 12» — один адрес.

// Слова адреса, которые пишут по-разному или пропускают; номера дома, корпуса и квартиры остаются.
const SKIP = new Set(['г', 'гор', 'город', 'ул', 'улица', 'д', 'дом', 'пр', 'пр-т', 'просп', 'проспект', 'пер', 'переулок', 'ш',
  'шоссе', 'б-р', 'бул', 'бульвар', 'наб', 'набережная', 'пл', 'площадь', 'обл', 'область', 'московская', 'москва', 'мо',
  'р-н', 'район', 'рн', 'к', 'корп', 'корпус', 'стр', 'строение', 'кв', 'квартира', 'пос', 'поселок', 'п', 'с', 'село',
  'дер', 'деревня', 'россия', 'рф']);

export function objectKey(id, value) {
  const s = String(value ?? '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!s) return '';
  if (id !== 'address') return s.replace(/[^\p{L}\d]/gu, '');
  // «5к2» и «5 к 2» — одно: буквы и цифры, слипшиеся вместе, разделяются.
  const words = s.replace(/(\d)(\p{L})/gu, '$1 $2').replace(/(\p{L})(\d)/gu, '$1 $2').split(/[^\p{L}\d-]+/u);
  return words.map((w) => w.replace(/^-+|-+$/g, '')).filter((w) => w && !SKIP.has(w)).join(' ');
}

// Сравнение полей match двух дел: { same, fields: [{ id, label, past, now, same }] } — только поля, заполненные хоть в одном.
export function compareObject(spec, past, cur) {
  const fields = [];
  let equal = 0;
  let differ = 0;
  for (const f of spec.match) {
    const a = objectKey(f.id, past.fields?.[f.id]);
    const b = objectKey(f.id, cur.fields?.[f.id]);
    if (!a && !b) continue;
    const same = !!a && a === b;
    if (a && b) { if (same) equal += 1; else differ += 1; }
    fields.push({ id: f.id, label: f.label, past: past.fields?.[f.id] ?? null, now: cur.fields?.[f.id] ?? null, same });
  }
  return { same: equal > 0 && differ === 0, fields };
}

// Прошлому отчёту больше 6 месяцев (2.367): объект мог измениться, выписка ЕГРН устарела. Дни — по Москве, 'ГГГГ-ММ-ДД'.
// Полных месяцев между днями: с 15 марта по 14 сентября — 5, по 15 сентября — 6.
export const STALE_MONTHS = 6;

export function fullMonths(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}

// { day, months, egrn } — если отчёт старше STALE_MONTHS; egrn — объект недвижимости (узнаётся по кадастровому номеру).
export function staleReport(spec, day, today) {
  if (!day) return null;
  const months = fullMonths(day, today);
  if (months < STALE_MONTHS) return null;
  return { day, months, egrn: spec.match.some((f) => f.id === 'cadastral') };
}

// Осмотр прошлого дела (2.428): акт прошлого осмотра — образец (что снимали, как описали), к новому отчёту прикладывается акт
// осмотра этого дела. День — последнего снимка по Москве; старше STALE_MONTHS — нужен новый осмотр.
// { day, photos, months, stale } или null — фото осмотра в прошлом деле нет.
export function pastInspection(day, photos, today) {
  if (!day || !photos) return null;
  const months = fullMonths(day, today);
  return { day, photos, months, stale: months >= STALE_MONTHS };
}
