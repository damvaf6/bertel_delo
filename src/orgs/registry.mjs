// Перечень отчётов для СРО (2.401): сданные экспертом за год (или квартал) отчёты об оценке — по услугам, где модуль сверяет
// отчёт с законом об оценке (правило `dossier_appraiser`). У каждого — дата сдачи, объект, цель оценки, заказчик; номер
// отчёта, дата составления и итоговая стоимость — из файлов результата дела (`reportFacts`, те же правила, что сверка 2.116
// и 2.108); чего не нашлось — пусто и пометка «дописать». Только свои дела эксперта (и частные, и от организации).
// Сданные — в «готово» и закрытые заказчиком после него (2.407: закрытое дело из перечня не пропадает).
// Годы — текущий и три прошлых (плановая проверка СРО — раз в три года). Выгрузка — CSV для Excel, как сводка за месяц.
import { reportFacts } from '../ai/report-checks.mjs';
import { resultDocs } from '../ops/ai-ops.mjs';
import { todayMsk } from '../orders/workflow.mjs';
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
const numberKey = (n) => String(n).replace(/\s+/g, '').toLowerCase();
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

// Сданные за период дела → строки перечня (номер, дата составления, стоимость — из файлов результата).
async function registryRows(sql, storage, registry, done, period) {
  const list = done.filter((o) => isAppraisal(registry, o)).sort((a, b) => new Date(a.at) - new Date(b.at));
  const rows = [];
  for (const o of list.slice(0, REGISTRY_MAX)) {
    const svc = registry.service(o.module, o.service);
    const docs = storage ? await resultDocs(sql, storage, o) : [];
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

export async function expertRegistry(sql, storage, registry, userId, period) {
  const done = await sql`
    select distinct on (o.id) o.id, o.title, o.module, o.service, o.fields, o.executor_user_id, h.at,
      coalesce(g.name, u.full_name) as customer
    from order_status_history h join orders o on o.id = h.order_id join users u on u.id = o.owner_user_id
    left join organizations g on g.id = o.org_id
    where o.executor_user_id = ${userId} and o.status in ('done', 'closed') and h.to_status = 'done'
      and h.at >= (${period.from}::date)::timestamp at time zone 'Europe/Moscow'
      and h.at < (${period.to}::date)::timestamp at time zone 'Europe/Moscow'
    order by o.id, h.at desc`;
  return registryRows(sql, storage, registry, done, period);
}

// Перечень по организации (2.402): сданные отчёты об оценке всех экспертов, работающих от организации, — как сводка за
// месяц (2.78): только сданное после вступления эксперта в организацию. У строки — эксперт; итог — по каждому эксперту;
// staff — сколько экспертов работает от организации сейчас.
export async function orgRegistry(sql, storage, registry, orgId, period) {
  const done = await sql`
    select distinct on (o.id) o.id, o.title, o.module, o.service, o.fields, o.executor_user_id, o.executor_user_id as expert_id, h.at,
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
  return r;
}

const ruDay = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const rubCell = (r) => (r == null ? '' : String(r));

// org — перечень организации (2.402): заголовок с её названием и столбец «Оценщик».
export function registryCsv(name, r, { org = false } = {}) {
  const lines = [
    [`Перечень отчётов об оценке — ${name}`],
    [`Период: ${r.name}`],
    [],
    ['№ п/п', 'Номер отчёта', 'Дата составления', ...(org ? ['Оценщик'] : []), 'Объект оценки', 'Услуга', 'Цель оценки', 'Заказчик',
      'Итоговая стоимость, ₽', 'Что за стоимость', 'Сдано'],
    ...r.rows.map((x, i) => [i + 1, x.number ?? '', ruDay(x.made_on), ...(org ? [x.expert_name] : []), x.object, x.service_name,
      x.purpose ?? '', x.customer ?? '', rubCell(x.value_rub), x.value_name ?? '', ruDay(x.done_on)]),
    ...(r.rows.some((x) => x.dup) ? [[], ['Номер отчёта повторяется — у каждого отчёта свой номер: '
      + [...new Set(r.rows.filter((x) => x.dup).map((x) => `№ ${x.number}${org ? ` (${x.expert_name})` : ''}`))].join(', ')]] : []),
    ...(r.total > r.shown ? [[], [`Показаны первые ${r.shown} из ${r.total} — выберите квартал`]] : []),
  ];
  return `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}
