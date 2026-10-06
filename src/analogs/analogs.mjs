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
    if (!a.confirmed_at) w.push(a.suggested ? 'Признаки предложил ИИ — проверьте и подтвердите' : 'Не подтверждён экспертом');
    per.set(a.id, w);
  }
  const confirmed = list.filter((a) => a.confirmed_at).length;
  const hints = [];
  if (confirmed < spec.min) hints.push(`Нужно не меньше ${spec.min} аналогов — подтверждено ${confirmed}`);
  const dup = [...byKey.values()].some((n) => n > 1);
  if (dup) hints.push('Есть повторяющиеся ссылки');
  if (list.some((a) => !a.file_key)) hints.push('Не у всех аналогов есть скриншот');
  return { per, hints, confirmed };
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

// Таблица аналогов для Word (строки «| … |»): № — номер приложения со скриншотом, источник — сайт и дата. Есть
// корректировки (2.74) — ещё столбцы «всего» и «цена после корректировок», а под таблицей — таблица самих корректировок.
export function analogTable(spec, list) {
  const own = spec.fields;
  const any = list.some((a) => a.adjustments?.length);
  const perSqm = any && own.some((f) => f.id === 'area') && list.some((a) => adjusted(a)?.per_sqm);
  const head = ['№', 'Источник', 'Цена, руб.', ...own.map((f) => f.label), 'Регион',
    ...(any ? ['Корректировки, всего', 'Цена после корректировок, руб.'] : []), ...(perSqm ? ['За кв. м после корректировок, руб.'] : [])];
  const cell = (s) => String(s ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim() || '—';
  const line = (r) => `| ${r.map(cell).join(' | ')} |`;
  const rows = list.map((a, i) => {
    const sum = adjusted(a);
    return [
      String(i + 1),
      [hostOf(a.url), a.fields.listed_on ? `от ${ruDate(a.fields.listed_on)}` : ''].filter(Boolean).join(', '),
      valueText(CORE_FIELDS[0], a.fields.price_rub),
      ...own.map((f) => valueText(f, a.fields[f.id])),
      valueText(CORE_FIELDS[2], a.fields.region),
      ...(any ? [sum ? pctText(sum.pct) : 'нет', sum ? fmtNum(sum.price) : valueText(CORE_FIELDS[0], a.fields.price_rub)] : []),
      ...(perSqm ? [sum?.per_sqm ? fmtNum(sum.per_sqm) : ''] : []),
    ];
  });
  const out = [head, ...rows].map(line);
  if (!any) return out;
  const adj = list.flatMap((a, i) => (a.adjustments ?? []).map((x) => [String(i + 1), adjustName(spec, x), pctText(x.pct), adjustSource(x)]));
  return [...out, 'Корректировки к аналогам (применяются по порядку, одна за другой):',
    ...[['Аналог', 'Корректировка', 'Значение', 'Источник (справочник, год, таблица)'], ...adj].map(line)];
}

// Для черновика от ИИ: подтверждённые аналоги строками (без ссылок — модели они не нужны).
export function analogsBrief(spec, list) {
  if (!list.length) return null;
  const fields = analogFields(spec);
  return ['АНАЛОГИ (подтверждены экспертом; таблицу программа вставит сама — не рисуй её):',
    ...list.map((a, i) => {
      const own = fields.filter((f) => a.fields[f.id] !== undefined).map((f) => `${f.label} — ${valueText(f, a.fields[f.id])}`);
      const sum = adjusted(a);
      const adj = sum ? [`корректировки — ${a.adjustments.map((x) => `${adjustName(spec, x)} ${pctText(x.pct)}${adjustSource(x) ? ` (${adjustSource(x)})` : ''}`).join(', ')}`,
        `цена после корректировок — ${fmtNum(sum.price)} руб.`] : [];
      return `- Аналог ${i + 1}: ${[...own, ...adj].join('; ')}`;
    })].join('\n');
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
    return {
      criteria: `Участок ${sel('land_use') ? `(${sel('land_use')})` : ''} рядом с «${f.address || where}», площадь близкая к ${f.area || '…'} кв. м`,
      links: [
        { name: 'Авито', url: `https://www.avito.ru/${avitoCity}/zemelnye_uchastki` },
        { name: 'ЦИАН', url: `https://www.cian.ru/cat.php?deal_type=sale&engine_version=2&offer_type=suburban&object_type%5B0%5D=3&region=${f.region === 'mo' ? 4593 : 1}` },
        { name: 'Торги (torgi.gov.ru)', url: 'https://torgi.gov.ru/new/public' },
      ],
    };
  }
  const first = String(f.items ?? '').split(/[\n,;]/)[0].trim().slice(0, 80);
  return {
    criteria: `${first || 'То же имущество'}; близкий год и состояние; ${where}`,
    links: [{ name: 'Авито', url: `https://www.avito.ru/${avitoCity}?q=${enc(first)}` }],
  };
}
