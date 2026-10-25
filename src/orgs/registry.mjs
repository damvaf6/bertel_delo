// Перечень отчётов для СРО (2.401): сданные экспертом за год (или квартал) отчёты об оценке — по услугам, где модуль сверяет
// отчёт с законом об оценке (правило `dossier_appraiser`). У каждого — дата сдачи, объект, цель оценки, заказчик; номер
// отчёта, дата составления и итоговая стоимость — из файлов результата дела (`reportFacts`, те же правила, что сверка 2.116
// и 2.108); чего не нашлось — пусто и пометка «дописать». Только свои дела эксперта (и частные, и от организации).
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

export async function expertRegistry(sql, storage, registry, userId, period) {
  const done = await sql`
    select distinct on (o.id) o.id, o.title, o.module, o.service, o.fields, o.executor_user_id, h.at,
      coalesce(g.name, u.full_name) as customer
    from order_status_history h join orders o on o.id = h.order_id join users u on u.id = o.owner_user_id
    left join organizations g on g.id = o.org_id
    where o.executor_user_id = ${userId} and o.status = 'done' and h.to_status = 'done'
      and h.at >= (${period.from}::date)::timestamp at time zone 'Europe/Moscow'
      and h.at < (${period.to}::date)::timestamp at time zone 'Europe/Moscow'
    order by o.id, h.at desc`;
  const list = done.filter((o) => isAppraisal(registry, o)).sort((a, b) => new Date(a.at) - new Date(b.at));
  const rows = [];
  for (const o of list.slice(0, REGISTRY_MAX)) {
    const svc = registry.service(o.module, o.service);
    const facts = storage ? reportFacts((await resultDocs(sql, storage, o)).filter((d) => d.pages)) : {};
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
    };
    row.missing = [['number', 'номер отчёта'], ['made_on', 'дата составления'], ['value_rub', 'итоговая стоимость']]
      .filter(([k]) => row[k] == null).map(([, t]) => t);
    rows.push(row);
  }
  return { year: period.year, quarter: period.quarter, name: period.name, years: period.years, total: list.length,
    shown: rows.length, rows };
}

const ruDay = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const rubCell = (r) => (r == null ? '' : String(r));

export function registryCsv(expertName, r) {
  const lines = [
    [`Перечень отчётов об оценке — ${expertName}`],
    [`Период: ${r.name}`],
    [],
    ['№ п/п', 'Номер отчёта', 'Дата составления', 'Объект оценки', 'Услуга', 'Цель оценки', 'Заказчик',
      'Итоговая стоимость, ₽', 'Что за стоимость', 'Сдано'],
    ...r.rows.map((x, i) => [i + 1, x.number ?? '', ruDay(x.made_on), x.object, x.service_name, x.purpose ?? '',
      x.customer ?? '', rubCell(x.value_rub), x.value_name ?? '', ruDay(x.done_on)]),
    ...(r.total > r.shown ? [[], [`Показаны первые ${r.shown} из ${r.total} — выберите квартал`]] : []),
  ];
  return `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}
