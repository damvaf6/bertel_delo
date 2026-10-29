// Перечень отчётов для СРО (2.401): сданные экспертом за год (или квартал) отчёты об оценке — по услугам, где модуль сверяет
// отчёт с законом об оценке (правило `dossier_appraiser`). У каждого — дата сдачи, объект, цель оценки, заказчик; номер
// отчёта, дата составления и итоговая стоимость — из файлов результата дела (`reportFacts`, те же правила, что сверка 2.116
// и 2.108); чего не нашлось — пусто и пометка «дописать». Только свои дела эксперта (и частные, и от организации).
// Сданные — в «готово» и закрытые заказчиком после него (2.407: закрытое дело из перечня не пропадает).
// Годы — текущий и три прошлых (плановая проверка СРО — раз в три года). Выгрузка — CSV для Excel, как сводка за месяц.
import { reportFacts } from '../ai/report-checks.mjs';
import { numberSource, resultDocs } from '../ops/ai-ops.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { formatNumber, guessPattern, numberKey, seqOf } from './numbering.mjs';
import { cell } from './report.mjs';

export const REGISTRY_YEARS_BACK = 3;
// Больше дел за период не читаем (файлы каждого дела читаются заново).
export const REGISTRY_MAX = 300;
const QUARTER_RU = ['', 'I квартал', 'II квартал', 'III квартал', 'IV квартал'];

const dayMsk = (t) => todayMsk(new Date(t));

export function registryYears(today = todayMsk()) {
  const y = Number(today.slice(0, 4));
  return Array.from({ length: REGISTRY_YEARS_BACK + 1 }, (_, i) => y - i);
}

// Период из запроса: ?year=2026&quarter=4 (без квартала — весь год). Неизвестное — текущий год.
export function registryPeriod(query = {}, today = todayMsk()) {
  const years = registryYears(today);
  const year = years.includes(Number(query.year)) ? Number(query.year) : years[0];
  const quarter = /^[1-4]$/.test(String(query.quarter ?? '')) ? Number(query.quarter) : 0;
  const from = quarter ? `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01` : `${year}-01-01`;
  const to = quarter ? (quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}-01`) : `${year + 1}-01-01`;
  return { year, quarter, from, to, name: quarter ? `${QUARTER_RU[quarter]} ${year} года` : `${year} год`, years };
}

// 2.404: чего не нашлось в файле отчёта — где это обычно пишут (так ищет и сверка 2.116, 2.108).
export const REGISTRY_WHERE = {
  number: 'номер — на титульном листе «Отчёт об оценке № …» и в колонтитуле',
  made_on: 'дата составления — рядом с номером «от …» или строкой «Дата составления отчёта» в общих сведениях',
  value_rub: 'итоговая стоимость — в разделе «Итоговая величина стоимости» и в сопроводительном письме: «… составляет … руб.»',
};
const MISSING = [['number', 'номер отчёта'], ['made_on', 'дата составления'], ['value_rub', 'итоговая стоимость']];

// Файлы результата дела: none — нет ни одного, unread — есть, но текст не читается (скан, картинка), text — прочитаны.
const filesState = (docs) => (!docs.length ? 'none' : docs.some((d) => d.pages) ? 'text' : 'unread');

// Прогон 2.410: номер отчёта — у каждого отчёта оценщика свой (ФСО); повтор в перечне виден сразу (в ИИ-проверке — 2.403).
// Дела экспертов у руководителя показывают завершённые за 90 дней (2.16) — к более старому делу ссылки из перечня нет.
export const CASES_DAYS = 90;

const isAppraisal = (registry, o) => registry.checks(o.module, o.service).some((c) => (c.auto ?? []).includes('dossier_appraiser'));

function optionName(fields, field, value) {
  const f = fields?.find((x) => x.id === field);
  return f?.options?.find((x) => x.id === value)?.name ?? null;
}

function objectOf(o) {
  const f = o.fields ?? {};
  if (f.address) return f.address;
  if (f.make_model) return [f.make_model, f.year ? `${f.year} г.` : null, f.vin ? `VIN ${f.vin}` : null].filter(Boolean).join(', ');
  return o.title;
}

// Новая редакция после замечаний к сданному отчёту (2.438, 2.434): файлы результата, загруженные после последних замечаний,
// заменяют в перечне прежнюю редакцию — номер, дата составления и стоимость берутся из них; у строки — edition: когда пришли
// замечания (remarks_on) и день новой редакции (on). Новой редакции ещё нет — перечень по прежним файлам, без edition.
export function editionDocs(o, docs) {
  if (!o.remarks_at) return { docs };
  const fresh = docs.filter((d) => new Date(d.created_at) >= new Date(o.remarks_at));
  if (!fresh.length || fresh.length === docs.length) return { docs };
  return { docs: fresh, edition: { on: dayMsk(fresh[0].created_at), remarks_on: dayMsk(o.remarks_at), prior: docs.length - fresh.length } };
}

// Сданные за период дела → строки перечня (номер, дата составления, стоимость — из файлов результата).
async function registryRows(sql, storage, registry, done, period) {
  const list = done.filter((o) => isAppraisal(registry, o)).sort((a, b) => new Date(a.at) - new Date(b.at));
  const rows = [];
  for (const o of list.slice(0, REGISTRY_MAX)) {
    const svc = registry.service(o.module, o.service);
    const { docs, edition } = editionDocs(o, storage ? await resultDocs(sql, storage, o) : []);
    const facts = reportFacts(docs.filter((d) => d.pages));
    const row = {
      id: o.id,
      title: o.title,
      service_name: svc?.service.name ?? o.service,
      object: objectOf(o),
      purpose: optionName(svc?.fields, 'purpose', o.fields?.purpose),
      customer: o.customer || null,
      done_on: dayMsk(o.at),
      number: facts.number ?? null,
      made_on: facts.made_on ?? null,
      value_rub: facts.value_rub ?? null,
      value_name: facts.value_name ?? null,
      ...(edition ? { edition } : {}),
      ...(o.expert_id ? { expert_id: o.expert_id, expert_name: o.expert_name || 'Без имени' } : {}),
    };
    const gaps = MISSING.filter(([k]) => row[k] == null);
    row.missing = gaps.map(([, t]) => t);
    row.files = filesState(docs);
    // Подсказка, где искать, — только когда текст файла прочитан: без файла или со сканом искать нечего.
    row.where = row.files === 'text' ? gaps.map(([k]) => REGISTRY_WHERE[k]) : [];
    if (o.in_cases != null) row.in_cases = o.in_cases;
    rows.push(row);
  }
  const seen = new Map();
  for (const x of rows.filter((x) => x.number != null)) {
    const k = `${x.expert_id ?? ''}|${numberKey(x.number)}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const x of rows) x.dup = x.number != null && seen.get(`${x.expert_id ?? ''}|${numberKey(x.number)}`) > 1;
  return { year: period.year, quarter: period.quarter, name: period.name, years: period.years, total: list.length,
    shown: rows.length, rows };
}

// Пропуски в нумерации за год (2.416): порядковые номера по образцу между наименьшим и наибольшим из номеров сданных отчётов
// перечня, которых в перечне нет. У каждого — почему, если платформа знает: номер выдан делу, а дело отменено (cancelled), ещё
// не сдано (open) или в файле сданного отчёта другой номер (file); не знает — unknown («дело отменено или номер пропущен?»).
// Номер, выданный и отменённому делу, и делу в работе (освобождён, 2.418), — по делу в работе.
// Номера до первого сданного в платформе не считаем: отчёты до неё в перечень не попадают. Показываем первые HOLES_MAX.
export const HOLES_MAX = 30;
// Отменённое дело (2.418): эксперт освободил номер — его получит следующее дело (freed), оставил пропуском (kept), не выбрал.
const CANCELLED = { true: 'freed', false: 'kept', null: 'cancelled' };
const OPEN_DONE = ['done', 'closed'];
export function numberHoles(pattern, year, rows, issued) {
  const present = new Set(rows.map((x) => (x.number != null ? seqOf(pattern, x.number, year) : null)).filter((n) => n != null));
  const out = { pattern, total: 0, list: [] };
  // Один номер — сравнивать не с чем.
  if (present.size < 2) return out;
  const min = Math.min(...present);
  const max = Math.max(...present);
  const bySeq = new Map();
  for (const e of issued) {
    const n = seqOf(pattern, e.number, year);
    if (n != null && (!bySeq.has(n) || bySeq.get(n).status === 'cancelled')) bySeq.set(n, e);
  }
  for (let n = min + 1; n < max; n++) {
    if (present.has(n)) continue;
    out.total++;
    if (out.list.length >= HOLES_MAX) continue;
    const e = bySeq.get(n);
    const reason = !e ? 'unknown' : e.status === 'cancelled' ? CANCELLED[String(e.free ?? null)] : OPEN_DONE.includes(e.status) ? 'file' : 'open';
    out.list.push({ seq: n, number: formatNumber(pattern, n, year), reason,
      ...(e ? { order_id: e.id, title: e.title, ...(e.expert_name ? { expert_name: e.expert_name } : {}) } : {}) });
  }
  out.from = formatNumber(pattern, min, year);
  out.to = formatNumber(pattern, max, year);
  return out;
}

const yearFrom = (period) => `${period.year}-01-01`;
const yearTo = (period) => `${period.year + 1}-01-01`;

// Эксперт: по своему образцу (нет — по последнему номеру из перечня, guessed). Номера выдаёт организация (2.415) — общий
// счёт с коллегами, пропуски в нём видит руководитель: { org }. Только за весь год, не за квартал.
async function expertHoles(sql, userId, period, rows) {
  const src = await numberSource(sql, userId);
  if (src.org) return { org: src.org.name };
  const last = rows.filter((x) => x.number != null).at(-1)?.number;
  const pattern = src.own ?? guessPattern(last, period.year);
  if (!pattern) return null;
  const issued = await sql`select id, title, status, report_number as number, report_number_free as free from orders
    where report_number_by = ${userId} and report_number_org is null and report_number is not null
      and report_number_on >= ${yearFrom(period)}::date and report_number_on < ${yearTo(period)}::date order by report_number_on`;
  return { ...numberHoles(pattern, period.year, rows, issued), guessed: !src.own };
}

// Руководитель: только по общему счёту организации (её образец задан) — свои образцы экспертов ведут и частные дела,
// которых в перечне организации нет, пропуски там были бы ложными.
async function orgHoles(sql, orgId, period, rows) {
  const g = await sql.one`select report_pattern from organizations where id = ${orgId}`;
  if (!g?.report_pattern) return null;
  const issued = await sql`select o.id, o.title, o.status, o.report_number as number, o.report_number_free as free, coalesce(e.full_name, 'Без имени') as expert_name
    from orders o left join users e on e.id = o.report_number_by
    where o.report_number_org = ${orgId} and o.report_number is not null
      and o.report_number_on >= ${yearFrom(period)}::date and o.report_number_on < ${yearTo(period)}::date order by o.report_number_on`;
  return numberHoles(g.report_pattern, period.year, rows, issued);
}

export async function expertRegistry(sql, storage, registry, userId, period) {
  const done = await sql`
    select distinct on (o.id) o.id, o.title, o.module, o.service, o.fields, o.executor_user_id, o.remarks_at, h.at,
      coalesce(g.name, u.full_name) as customer
    from order_status_history h join orders o on o.id = h.order_id join users u on u.id = o.owner_user_id
    left join organizations g on g.id = o.org_id
    where o.executor_user_id = ${userId} and o.status in ('done', 'closed') and h.to_status = 'done'
      and h.at >= (${period.from}::date)::timestamp at time zone 'Europe/Moscow'
      and h.at < (${period.to}::date)::timestamp at time zone 'Europe/Moscow'
    order by o.id, h.at desc`;
  const r = await registryRows(sql, storage, registry, done, period);
  r.holes = period.quarter ? null : await expertHoles(sql, userId, period, r.rows);
  return r;
}

// Перечень по организации (2.402): сданные отчёты об оценке всех экспертов, работающих от организации, — как сводка за
// месяц (2.78): только сданное после вступления эксперта в организацию. У строки — эксперт; итог — по каждому эксперту;
// staff — сколько экспертов работает от организации сейчас.
// Сданные за период дела экспертов, работающих от организации (после вступления), — для перечня и поиска по номеру (2.417).
async function orgDone(sql, orgId, period) {
  return sql`
    select distinct on (o.id) o.id, o.title, o.module, o.service, o.fields, o.executor_user_id, o.executor_user_id as expert_id, o.remarks_at, h.at,
      o.updated_at > now() - ${CASES_DAYS}::int * interval '1 day' as in_cases,
      coalesce(g.name, u.full_name) as customer, e.full_name as expert_name
    from order_status_history h join orders o on o.id = h.order_id join users u on u.id = o.owner_user_id
    join specialists s on s.user_id = o.executor_user_id and s.org_id = ${orgId}
    join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
    join users e on e.id = o.executor_user_id
    left join organizations g on g.id = o.org_id
    where o.status in ('done', 'closed') and h.to_status = 'done' and h.at >= m.created_at
      and h.at >= (${period.from}::date)::timestamp at time zone 'Europe/Moscow'
      and h.at < (${period.to}::date)::timestamp at time zone 'Europe/Moscow'
    order by o.id, h.at desc`;
}

export async function orgRegistry(sql, storage, registry, orgId, period) {
  const done = await orgDone(sql, orgId, period);
  const r = await registryRows(sql, storage, registry, done, period);
  const by = new Map();
  for (const x of r.rows) {
    const e = by.get(x.expert_id) ?? by.set(x.expert_id, { id: x.expert_id, name: x.expert_name, n: 0, gaps: 0, dups: 0 }).get(x.expert_id);
    e.n++;
    if (x.missing.length) e.gaps++;
    if (x.dup) e.dups++;
  }
  r.experts = [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ru'));
  // Экспертов, работающих от организации, нет — карточку перечня не показываем (как сводку за месяц).
  r.staff = (await sql.one`select count(*)::int as n from specialists where org_id = ${orgId}`).n;
  r.holes = period.quarter ? null : await orgHoles(sql, orgId, period, r.rows);
  return r;
}

// Поиск дела по номеру отчёта (2.417): руководитель знает номер из письма банка или СРО, а в «Делах экспертов» — номера дел
// платформы. Каждое слово (часть номера) запроса — целой частью номера: «14» найдёт «14/2026» и «В-14», но не «140/2026»;
// регистр, «ё», знаки и похожие латинские буквы («B-14» вместо «В-14») не важны. Где искать: номера, выданные делам
// экспертов организации (2.412, и дела в работе), и номера из файлов отчётов, сданных за этот и прошлый год (как в перечне).
const LATIN = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const numParts = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[a-z]/g, (ch) => LATIN[ch] ?? ch)
  .split(/[^0-9a-zа-я]+/).filter(Boolean);
export function numberMatch(q, number) {
  const w = numParts(q);
  const parts = numParts(number);
  return w.length > 0 && w.some((x) => /\d/.test(x)) && w.every((x) => parts.includes(x));
}
export const NUMBER_FIND_MAX = 20;
export async function orgFindNumber(sql, storage, registry, orgId, q, today = todayMsk()) {
  const year = Number(today.slice(0, 4));
  const found = new Map();
  const issued = await sql`
    select o.id, o.module, o.service, o.status, o.updated_at, o.report_number as number, e.full_name as expert_name,
      (select max(h.at) from order_status_history h where h.order_id = o.id and h.to_status = 'done') as done_at
    from orders o join specialists s on s.user_id = o.executor_user_id and s.org_id = ${orgId}
    join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
    join users e on e.id = o.executor_user_id
    where o.report_number is not null and o.report_number_on >= ${`${year - 1}-01-01`}::date and o.updated_at >= m.created_at
    order by o.report_number_on desc, o.updated_at desc`;
  for (const o of issued.filter((x) => numberMatch(q, x.number))) found.set(o.id, { ...o, done_on: o.done_at ? dayMsk(o.done_at) : null });
  for (const y of [year, year - 1]) {
    const period = registryPeriod({ year: y }, today);
    const done = (await orgDone(sql, orgId, period)).filter((o) => !found.has(o.id));
    const status = new Map(done.map((o) => [o.id, o]));
    const { rows } = await registryRows(sql, storage, registry, done, period);
    for (const r of rows.filter((x) => numberMatch(q, x.number))) {
      const o = status.get(r.id);
      found.set(r.id, { id: r.id, module: o.module, service: o.service, status: 'done', updated_at: null, in_cases: o.in_cases,
        number: r.number, expert_name: r.expert_name, done_on: r.done_on });
    }
  }
  return [...found.values()].slice(0, NUMBER_FIND_MAX);
}

const ruDay = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const rubCell = (r) => (r == null ? '' : String(r));

const HOLE_CSV = { cancelled: 'дело отменено', open: 'дело ещё не сдано', file: 'в файле отчёта другой номер', unknown: 'нет в перечне' };

// org — перечень организации (2.402): заголовок с её названием и столбец «Оценщик».
export function registryCsv(name, r, { org = false } = {}) {
  const lines = [
    [`Перечень отчётов об оценке — ${name}`],
    [`Период: ${r.name}`],
    [],
    ['№ п/п', 'Номер отчёта', 'Дата составления', ...(org ? ['Оценщик'] : []), 'Объект оценки', 'Услуга', 'Цель оценки', 'Заказчик',
      'Итоговая стоимость, ₽', 'Что за стоимость', 'Сдано', 'Редакция'],
    ...r.rows.map((x, i) => [i + 1, x.number ?? '', ruDay(x.made_on), ...(org ? [x.expert_name] : []), x.object, x.service_name,
      x.purpose ?? '', x.customer ?? '', rubCell(x.value_rub), x.value_name ?? '', ruDay(x.done_on),
      x.edition ? `новая от ${ruDay(x.edition.on)} (после замечаний от ${ruDay(x.edition.remarks_on)})` : '']),
    ...(r.rows.some((x) => x.dup) ? [[], ['Номер отчёта повторяется — у каждого отчёта свой номер: '
      + [...new Set(r.rows.filter((x) => x.dup).map((x) => `№ ${x.number}${org ? ` (${x.expert_name})` : ''}`))].join(', ')]] : []),
    ...(r.holes?.total ? [[], [`Пропуски в нумерации (с № ${r.holes.from} по № ${r.holes.to}): `
      + r.holes.list.map((h) => `№ ${h.number} — ${HOLE_CSV[h.reason]}`).join('; ') + (r.holes.total > r.holes.list.length ? ` и ещё ${r.holes.total - r.holes.list.length}` : '')]] : []),
    ...(r.total > r.shown ? [[], [`Показаны первые ${r.shown} из ${r.total} — выберите квартал`]] : []),
  ];
  return `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}
