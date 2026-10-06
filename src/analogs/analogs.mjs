// Аналоги в деле (2.32; план docs/analogi-plan.md, способ А): признаки ядра, проверка значений, предупреждения и
// подсказки эксперту, строки таблицы для Word и сведения для черновика. Признаки по виду объекта — в описании модуля
// (analogs), здесь — только то, что есть у каждого аналога: цена, дата объявления, регион.
import { HttpError } from '../http/core.mjs';
import { cleanValues, missingRequired } from '../modules/index.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';

export const REGIONS = [{ id: 'moscow', name: 'Москва' }, { id: 'mo', name: 'Московская область' }, { id: 'other', name: 'Другой регион' }];
export const CORE_FIELDS = [
  { id: 'price_rub', label: 'Цена, руб.', type: 'number', required: true, min: 1, max: 100_000_000_000 },
  { id: 'listed_on', label: 'Дата объявления', type: 'text', max: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$', hint: 'дата объявления' },
  { id: 'region', label: 'Регион', type: 'select', options: REGIONS },
];
// Объявление старше полугода на дату оценки — предупреждение (план, п. 4).
export const OLD_DAYS = 183;
// Цена дальше этой доли от середины (медианы) остальных — «проверьте или поясните».
const PRICE_SPREAD = 0.35;

export const analogFields = (spec) => [...CORE_FIELDS, ...spec.fields];

// Перечень движимого имущества (2.80): позиции — через «;» или с новой строки, номера «1.» не в счёт. Если у аналогов
// есть признак «Позиция перечня» (item_no) и позиций больше одной, аналоги нужны к каждой позиции отдельно.
export const ITEM_FIELD = 'item_no';
export function listPositions(spec, order) {
  if (!spec?.fields.some((f) => f.id === ITEM_FIELD)) return [];
  const items = String(order.fields?.items ?? '').split(/[;\n]+/).map((x) => x.trim().replace(/^\d{1,2}[.)]\s*/, '')).filter(Boolean);
  return items.length > 1 ? items.slice(0, 100) : [];
}

// Ссылка на объявление: только http(s), без пробелов; ключ для поиска повторов — без меток рекламы и якоря.
export function cleanUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || !['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || s.length > 2000 || /\s/.test(s)) {
    throw new HttpError(400, 'bad_url', 'Вставьте ссылку на объявление (начинается с https://)');
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const keep = [...u.searchParams].filter(([k]) => !/^(utm_|from$|context$|ref$|yclid$|gclid$|fbclid$|_openstat$)/i.test(k));
  const query = keep.length ? `?${new URLSearchParams(keep).toString()}` : '';
  return { url: u.toString(), key: `${host}${u.pathname.replace(/\/+$/, '')}${query}`.toLowerCase(), host };
}

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^(www|m)\./, ''); } catch { return ''; } };

// Числа из объявлений приходят с пробелами и «₽» («1 250 000 ₽», «85 000 км») — оставляем цифры и дробную часть.
const numberish = (v) => (typeof v === 'string' && /\d/.test(v) ? v.replace(/[\s  ]/g, '').replace(/[^\d.,-]/g, '') : v);

// Значения признаков от эксперта или ИИ: типы и пределы — как у полей заявки; дата — настоящая и не в будущем.
export function cleanAnalogValues(spec, input) {
  const fields = analogFields(spec);
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const prepared = Object.fromEntries(Object.entries(src).map(([k, v]) => {
    const f = fields.find((x) => x.id === k);
    return [k, f?.type === 'number' ? numberish(v) : v];
  }));
  const out = cleanValues(fields, prepared);
  if (out.listed_on) {
    const d = new Date(`${out.listed_on}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out.listed_on || out.listed_on < '2000-01-01') {
      throw new HttpError(400, 'bad_date', 'Поле «Дата объявления»: укажите дату');
    }
    if (out.listed_on > todayMsk()) throw new HttpError(400, 'bad_date', 'Поле «Дата объявления»: дата ещё не наступила');
  }
  return out;
}

// То же для ответа ИИ: неверные и лишние значения просто отбрасываются — эксперт допишет сам.
export function suggestionValues(spec, input) {
  const out = {};
  for (const f of analogFields(spec)) {
    const v = input?.[f.id];
    if (v === undefined || v === null || v === '') continue;
    try { Object.assign(out, cleanAnalogValues(spec, { [f.id]: f.type === 'number' ? v : String(v) })); } catch { /* пропускаем */ }
  }
  return out;
}

export const missingAnalog = (spec, values) => missingRequired(analogFields(spec), values);

// Корректировки к аналогу (2.74): вид (из описания модуля или «Другая» со своим названием), значение в процентах и источник —
// справочник, год издания, таблица. Применяются по порядку, одна за другой: цена × (1 + п1/100) × (1 + п2/100)…
export const OTHER_ADJ = { id: 'other', name: 'Другая', covers: [] };
export const adjustKinds = (spec) => [...(spec.adjustments ?? []), OTHER_ADJ];
export const ADJ_MAX = 15;
// Общая корректировка больше этой доли — аналог сильно отличается от объекта («проверьте или поясните»).
const ADJ_SPREAD = 30;

export function cleanAdjustments(spec, input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'bad_input', 'Корректировки — списком');
  if (input.length > ADJ_MAX) throw new HttpError(400, 'bad_input', `К аналогу — не больше ${ADJ_MAX} корректировок`);
  const kinds = adjustKinds(spec);
  const year = Number(todayMsk().slice(0, 4));
  const str = (v, max, label) => {
    const t = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    if (t.length > max) throw new HttpError(400, 'bad_input', `Корректировка: «${label}» — не длиннее ${max} знаков`);
    return t;
  };
  return input.map((x, i) => {
    const src = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    const kind = kinds.find((k) => k.id === src.kind);
    const n = `Корректировка ${i + 1}`;
    if (!kind) throw new HttpError(400, 'bad_input', `${n}: выберите вид`);
    const out = { kind: kind.id };
    if (kind.id === OTHER_ADJ.id) {
      out.name = str(src.name, 60, 'Название');
      if (!out.name) throw new HttpError(400, 'bad_input', `${n}: напишите, что это за корректировка`);
    }
    const raw = typeof src.pct === 'string' ? src.pct.replace(/[\s  %]/g, '').replace(',', '.').replace(/^[−–]/, '-') : src.pct;
    const pct = raw === '' || raw === undefined || raw === null ? NaN : Number(raw);
    if (!Number.isFinite(pct) || pct < -90 || pct > 300) throw new HttpError(400, 'bad_input', `${n}: значение — число процентов от −90 до 300 (например, −5 или 3,5)`);
    out.pct = Math.round(pct * 100) / 100;
    const book = str(src.book, 200, 'Справочник');
    if (book) out.book = book;
    if (src.year !== undefined && src.year !== null && String(src.year).trim() !== '') {
      const y = Number(String(src.year).trim());
      if (!Number.isInteger(y) || y < 1990 || y > year + 1) throw new HttpError(400, 'bad_input', `${n}: год справочника — например, ${year}`);
      out.year = y;
    }
    const table = str(src.table, 40, 'Таблица');
    if (table) out.table = table;
    return out;
  });
}

export const adjustName = (spec, x) => (x.kind === OTHER_ADJ.id ? x.name : adjustKinds(spec).find((k) => k.id === x.kind)?.name ?? x.kind);
const pctText = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} %`;
export const adjustSource = (x) => [x.book, x.year ? `${x.year} г.` : '', x.table ? `табл. ${x.table.replace(/^(табл(ица)?\.?\s*)/iu, '')}` : ''].filter(Boolean).join(', ');

// Итог корректировок: общий процент и цена после них (рубли; за кв. м — когда у аналога есть площадь). Без корректировок — null.
export function adjusted(a) {
  const list = a.adjustments ?? [];
  const price = a.fields?.price_rub;
  if (!list.length || !Number.isFinite(price)) return null;
  const k = list.reduce((m, x) => m * (1 + x.pct / 100), 1);
  // toFixed — чтобы половинки не терялись на погрешности дробей; половина — от нуля (−3,575 % → −3,58 %).
  const half = (x, d = 0) => Math.sign(x) * Math.round(Number(Math.abs(x).toFixed(6)) * 10 ** d) / 10 ** d;
  const out = { pct: half((k - 1) * 100, 2), price: half(price * k) };
  if (Number.isFinite(a.fields.area) && a.fields.area > 0) out.per_sqm = Math.round(out.price / a.fields.area);
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Предупреждения по каждому аналогу и подсказки по разделу целиком. Ничего не запрещают: решает эксперт.
export function analogWarnings(spec, order, list) {
  const today = todayMsk();
  const old = addDays(today, -OLD_DAYS);
  const priced = list.filter((a) => Number.isFinite(a.fields.price_rub));
  const byKey = new Map();
  for (const a of list) byKey.set(a.url_key, (byKey.get(a.url_key) ?? 0) + 1);
  const per = new Map();
  const positions = listPositions(spec, order);
  for (const a of list) {
    const w = [];
    const adj = a.adjustments ?? [];
    const covered = new Set(adj.flatMap((x) => adjustKinds(spec).find((k) => k.id === x.kind)?.covers ?? []));
    if (byKey.get(a.url_key) > 1) w.push('Эта ссылка уже есть в деле — аналоги не должны повторяться');
    if (!a.file_key) w.push('Нет скриншота объявления — приложите снимок экрана или PDF страницы');
    const miss = missingAnalog(spec, a.fields);
    if (miss.length) w.push(`Не заполнено: ${miss.join(', ')}`);
    if (!a.fields.listed_on) w.push('Нет даты объявления');
    else if (a.fields.listed_on < old && !covered.has('date')) w.push('Объявление старше полугода — нужна корректировка на дату или другой аналог');
    const region = order.fields?.region;
    if (a.fields.region && region && a.fields.region !== region && !covered.has('region')) {
      w.push(`Другой регион (объект — ${REGIONS.find((r) => r.id === region)?.name ?? region}) — нужна корректировка`);
    }
    for (const f of spec.fields.filter((x) => x.near)) {
      const mine = Number(order.fields?.[f.near.field]);
      const v = a.fields[f.id];
      if (!Number.isFinite(mine) || !Number.isFinite(v) || covered.has(f.id)) continue;
      const far = f.near.within !== undefined ? Math.abs(v - mine) > f.near.within : Math.abs(v - mine) > (mine * f.near.pct) / 100;
      if (far) w.push(`${f.label}: ${v} у аналога, ${mine} у объекта — нужна корректировка`);
    }
    if (priced.length >= 3 && Number.isFinite(a.fields.price_rub)) {
      const others = priced.filter((x) => x !== a).map((x) => x.fields.price_rub);
      const mid = median(others);
      if (mid > 0 && Math.abs(a.fields.price_rub - mid) / mid > PRICE_SPREAD) w.push('Цена сильно отличается от остальных аналогов — проверьте или поясните в отчёте');
    }
    for (const x of adj) {
      const miss = [!x.book && 'справочник', !x.year && 'год', !x.table && 'таблицу'].filter(Boolean);
      if (miss.length) w.push(`Корректировка «${adjustName(spec, x)}»: укажите ${miss.join(', ')} — откуда взято значение`);
    }
    const sum = adjusted(a);
    if (sum && Math.abs(sum.pct) > ADJ_SPREAD) w.push(`Корректировки всего ${pctText(sum.pct)} — больше ${ADJ_SPREAD} %: аналог сильно отличается от объекта, проверьте или поясните в отчёте`);
    const no = a.fields[ITEM_FIELD];
    if (positions.length && no === undefined) w.push(`Укажите позицию перечня (1–${positions.length}): аналоги нужны к каждой позиции`);
    else if (positions.length && no > positions.length) w.push(`Позиций в перечне: ${positions.length} — проверьте номер позиции`);
    if (!a.confirmed_at) w.push(a.suggested ? 'Признаки предложил ИИ — проверьте и подтвердите' : 'Не подтверждён экспертом');
    per.set(a.id, w);
  }
  const done = list.filter((a) => a.confirmed_at);
  const hints = [];
  if (!positions.length) {
    if (done.length < spec.min) hints.push(`Нужно не меньше ${spec.min} аналогов — подтверждено ${done.length}`);
    return { per, hints: withCommon(hints), confirmed: done.length, min: spec.min };
  }
  // По позициям: в зачёт — не больше нужного числа к каждой, чтобы «6 из 6» не набиралось аналогами одной позиции.
  let counted = 0;
  positions.forEach((name, i) => {
    const n = done.filter((a) => a.fields[ITEM_FIELD] === i + 1).length;
    counted += Math.min(n, spec.min);
    if (n < spec.min) hints.push(`Нужно не меньше ${spec.min} аналогов к позиции ${i + 1} «${name.length > 60 ? `${name.slice(0, 59)}…` : name}» — подтверждено ${n}`);
  });
  return { per, hints: withCommon(hints), confirmed: counted, min: spec.min * positions.length };

  function withCommon(h) {
    if ([...byKey.values()].some((n) => n > 1)) h.push('Есть повторяющиеся ссылки');
    if (list.some((a) => !a.file_key)) h.push('Не у всех аналогов есть скриншот');
    return h;
  }
}

// Четырёхзначные числа — без пробела (2.66): год «1975», а не «1 975»; с 10 000 — по разрядам.
const fmtNum = (n) => Number(n).toLocaleString('ru-RU', { useGrouping: Math.abs(Number(n)) >= 10000 }).replace(/ /g, ' ');
const ruDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '');
export const timeMsk = (t) => new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function valueText(f, v) {
  if (v === undefined || v === null || v === '') return '';
  if (f.type === 'select') return f.options.find((o) => o.id === v)?.name ?? String(v);
  if (f.id === 'listed_on') return ruDate(v);
  if (f.type === 'number') return fmtNum(v);
  return String(v);
}

// Перечень из нескольких позиций (2.83): аналоги по позициям — 1, 2, …, без позиции (или с номером больше числа позиций) —
// в конце; внутри позиции — как добавлены. Один порядок для таблицы Word, приложения со скриншотами, черновика и ИИ-проверки:
// «Аналог 4» везде один и тот же. Одна позиция или не перечень — порядок не меняется.
const positionOf = (a, n) => { const no = a.fields?.[ITEM_FIELD]; return Number.isInteger(no) && no >= 1 && no <= n ? no : null; };
export function inItemOrder(spec, order, list) {
  const n = listPositions(spec, order).length;
  if (!n) return list;
  const key = (a) => positionOf(a, n) ?? n + 1;
  return list.map((a, i) => ({ a, i })).sort((x, y) => key(x.a) - key(y.a) || x.i - y.i).map((x) => x.a);
}

// Группы по позициям: { no, name, items: [{ a, n }] } (n — сквозной номер аналога), средняя цена аналогов (после
// корректировок, если они есть). Аналоги без позиции — отдельной группой с no = null.
export function itemGroups(spec, order, list) {
  const positions = listPositions(spec, order);
  if (!positions.length) return null;
  const sorted = inItemOrder(spec, order, list).map((a, i) => ({ a, n: i + 1 }));
  const groups = positions.map((name, i) => ({ no: i + 1, name, items: sorted.filter((x) => positionOf(x.a, positions.length) === i + 1) }));
  const rest = sorted.filter((x) => positionOf(x.a, positions.length) === null);
  if (rest.length) groups.push({ no: null, name: 'Позиция не указана', items: rest });
  for (const g of groups) {
    const prices = g.items.map(({ a }) => adjusted(a)?.price ?? a.fields?.price_rub).filter(Number.isFinite);
    g.mean = prices.length ? Math.round(prices.reduce((s, x) => s + x, 0) / prices.length) : null;
  }
  return groups;
}

// Таблица аналогов для Word (строки «| … |»): № — номер приложения со скриншотом, источник — сайт и дата. Есть
// корректировки (2.74) — ещё столбцы «всего» и «цена после корректировок», а под таблицей — таблица самих корректировок.
// Перечень из нескольких позиций (2.83) — своя таблица у каждой позиции, под ней средняя цена её аналогов, в конце —
// сводка по позициям; номера аналогов сквозные.
export function analogTable(spec, list, order = null) {
  const groups = order ? itemGroups(spec, order, list) : null;
  const sorted = groups ? groups.flatMap((g) => g.items.map((x) => x.a)) : list;
  const own = spec.fields.filter((f) => !(groups && f.id === ITEM_FIELD));
  const any = sorted.some((a) => a.adjustments?.length);
  const perSqm = any && own.some((f) => f.id === 'area') && sorted.some((a) => adjusted(a)?.per_sqm);
  const head = ['№', 'Источник', 'Цена, руб.', ...own.map((f) => f.label), 'Регион',
    ...(any ? ['Корректировки, всего', 'Цена после корректировок, руб.'] : []), ...(perSqm ? ['За кв. м после корректировок, руб.'] : [])];
  const cell = (s) => String(s ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim() || '—';
  const line = (r) => `| ${r.map(cell).join(' | ')} |`;
  const rowOf = (a, n) => {
    const sum = adjusted(a);
    return [
      String(n),
      [hostOf(a.url), a.fields.listed_on ? `от ${ruDate(a.fields.listed_on)}` : ''].filter(Boolean).join(', '),
      valueText(CORE_FIELDS[0], a.fields.price_rub),
      ...own.map((f) => valueText(f, a.fields[f.id])),
      valueText(CORE_FIELDS[2], a.fields.region),
      ...(any ? [sum ? pctText(sum.pct) : 'нет', sum ? fmtNum(sum.price) : valueText(CORE_FIELDS[0], a.fields.price_rub)] : []),
      ...(perSqm ? [sum?.per_sqm ? fmtNum(sum.per_sqm) : ''] : []),
    ];
  };
  const after = any ? 'после корректировок ' : '';
  const out = groups
    ? groups.flatMap((g) => [
      g.no ? `Позиция ${g.no}. ${g.name}` : 'Аналоги без позиции перечня (укажите позицию в разделе «Аналоги» дела)',
      ...(g.items.length ? [head, ...g.items.map(({ a, n }) => rowOf(a, n))].map(line) : ['Подтверждённых аналогов к этой позиции нет.']),
      ...(g.no && g.mean !== null ? [`Средняя цена аналогов позиции ${g.no} ${after}— ${fmtNum(g.mean)} руб.`] : []),
    ])
    : [head, ...sorted.map((a, i) => rowOf(a, i + 1))].map(line);
  const adj = any ? sorted.flatMap((a, i) => (a.adjustments ?? []).map((x) => [String(i + 1), adjustName(spec, x), pctText(x.pct), adjustSource(x)])) : [];
  const adjPart = any ? ['Корректировки к аналогам (применяются по порядку, одна за другой):',
    ...[['Аналог', 'Корректировка', 'Значение', 'Источник (справочник, год, таблица)'], ...adj].map(line)] : [];
  const summary = groups ? [`Цены аналогов по позициям перечня (средняя ${after}— справочно, стоимость позиции определяет оценщик):`,
    ...[['Позиция', 'Наименование', 'Аналоги', `Средняя цена ${after}, руб.`.replace(' ,', ',')],
      ...groups.filter((g) => g.no).map((g) => [String(g.no), g.name, g.items.length ? g.items.map((x) => x.n).join(', ') : 'нет', g.mean !== null ? fmtNum(g.mean) : '—'])].map(line)] : [];
  return [...out, ...adjPart, ...summary];
}

// Для черновика от ИИ: подтверждённые аналоги строками (без ссылок — модели они не нужны). Перечень (2.83) — по позициям,
// с той же сквозной нумерацией, что в Word.
export function analogsBrief(spec, list, order = null) {
  if (!list.length) return null;
  const fields = analogFields(spec);
  const lineOf = (a, n) => {
    const own = fields.filter((f) => a.fields[f.id] !== undefined).map((f) => `${f.label} — ${valueText(f, a.fields[f.id])}`);
    const sum = adjusted(a);
    const adj = sum ? [`корректировки — ${a.adjustments.map((x) => `${adjustName(spec, x)} ${pctText(x.pct)}${adjustSource(x) ? ` (${adjustSource(x)})` : ''}`).join(', ')}`,
      `цена после корректировок — ${fmtNum(sum.price)} руб.`] : [];
    return `- Аналог ${n}: ${[...own, ...adj].join('; ')}`;
  };
  const groups = order ? itemGroups(spec, order, list) : null;
  if (!groups) return ['АНАЛОГИ (подтверждены экспертом; таблицу программа вставит сама — не рисуй её):', ...list.map((a, i) => lineOf(a, i + 1))].join('\n');
  return ['АНАЛОГИ ПО ПОЗИЦИЯМ ПЕРЕЧНЯ (подтверждены экспертом; таблицы программа вставит сама — не рисуй их; корректировки и итог пиши по каждой позиции отдельно, стоимость позиции — [заполнить]):',
    ...groups.flatMap((g) => [
      g.no ? `Позиция ${g.no} «${g.name}»:` : 'Без позиции перечня:',
      ...(g.items.length ? g.items.map(({ a, n }) => lineOf(a, n)) : ['- аналогов нет']),
      ...(g.no && g.mean !== null ? [`- средняя цена аналогов позиции — ${fmtNum(g.mean)} руб.`] : []),
    ])].join('\n');
}

// Где искать (программа строит ссылки на поиск — открывает их сам эксперт в своём браузере; с сайтов мы ничего не берём).
export function searchHints(registry, order) {
  const f = order.fields ?? {};
  const where = f.region === 'mo' ? 'Московская область' : 'Москва';
  const avitoCity = f.region === 'mo' ? 'moskovskaya_oblast' : 'moskva';
  const def = registry.service(order.module, order.service);
  const sel = (id) => def?.fields.find((x) => x.id === id)?.options?.find((o) => o.id === f[id])?.name;
  const enc = encodeURIComponent;
  if (order.service === 'vehicle') {
    const what = [f.make_model, f.year ? `${f.year - 2}–${f.year + 2} г.` : null].filter(Boolean).join(', ');
    const q = f.make_model || '';
    return {
      criteria: `${what || 'Та же марка и модель'}; ${where}; та же комплектация; объявления не старше полугода`,
      links: [
        { name: 'Авито', url: `https://www.avito.ru/${avitoCity}/avtomobili?q=${enc(q)}` },
        { name: 'Авто.ру', url: `https://auto.ru/${f.region === 'mo' ? 'moskovskaya_oblast' : 'moskva'}/cars/all/` },
        { name: 'Дром', url: 'https://auto.drom.ru/' },
      ],
    };
  }
  if (order.service === 'realty') {
    const kind = sel('object_type') ?? 'Объект';
    const area = Number(f.area);
    const what = [kind, Number.isFinite(area) && area > 0 ? `${Math.round(area * 0.7)}–${Math.round(area * 1.3)} кв. м` : null].filter(Boolean).join(', ');
    return {
      criteria: `${what}; тот же район (${f.address || where}); тот же тип дома; объявления не старше полугода`,
      links: [
        { name: 'ЦИАН', url: `https://www.cian.ru/cat.php?deal_type=sale&engine_version=2&offer_type=flat&region=${f.region === 'mo' ? 4593 : 1}` },
        { name: 'Авито', url: `https://www.avito.ru/${avitoCity}/nedvizhimost` },
        { name: 'Домклик', url: 'https://domclick.ru/' },
      ],
    };
  }
  if (order.service === 'land') {
    // На сайтах участки — в сотках (2.80): диапазон площади ±30 % и в сотках, и в кв. м.
    const area = Number(f.area);
    const sot = (m) => String(Math.round(m / 10) / 10).replace('.', ',');
    const size = Number.isFinite(area) && area > 0 ? `${sot(area * 0.7)}–${sot(area * 1.3)} сот. (${fmtNum(Math.round(area * 0.7))}–${fmtNum(Math.round(area * 1.3))} кв. м)` : null;
    const low = (x) => (x ? `${x[0].toLowerCase()}${x.slice(1)}` : null);
    return {
      criteria: [`Участок${sel('land_use') ? `: ${low(sel('land_use'))}` : ''}`, low(sel('land_category')), size, `рядом с «${f.address || where}»`, 'объявления не старше полугода'].filter(Boolean).join('; '),
      links: [
        { name: 'Авито', url: `https://www.avito.ru/${avitoCity}/zemelnye_uchastki` },
        { name: 'ЦИАН', url: `https://www.cian.ru/cat.php?deal_type=sale&engine_version=2&offer_type=suburban&object_type%5B0%5D=3&region=${f.region === 'mo' ? 4593 : 1}` },
        { name: 'Торги (torgi.gov.ru)', url: 'https://torgi.gov.ru/new/public' },
      ],
    };
  }
  // Движимое (2.80): поиск — по каждой позиции перечня, без года и количества («Токарный станок 16К20»).
  const items = String(f.items ?? '').split(/[;\n]+/).map((x) => x.trim().replace(/^\d{1,2}[.)]\s*/, '').split(',')[0].trim().slice(0, 80)).filter(Boolean);
  const many = items.length > 1;
  return {
    criteria: `${many ? 'К каждой позиции перечня — свои аналоги' : items[0] || 'То же имущество'}; близкий год выпуска, состояние и комплектация; ${where}; объявления не старше полугода`,
    links: (items.length ? items : ['']).slice(0, 5).map((q, i) => ({ name: many ? `Авито: ${i + 1}. ${q}` : 'Авито', url: `https://www.avito.ru/${avitoCity}?q=${enc(q)}` })),
  };
}
