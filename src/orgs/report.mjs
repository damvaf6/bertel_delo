// Сводка руководителю за месяц по экспертам (2.78): сколько дел каждый принял, сдал (готово), из них позже срока, сколько
// раз возвращали (руководитель — до подписи организации, диспетчер — на доработку), вознаграждение за сданные и выплачено.
// Считается только то, что было с тех пор, как эксперт состоит в организации, — прошлые частные дела руководитель не видит.
// Частые пункты замечаний (2.105): пункты возвратов руководителя (2.93) за месяц — одинаковые без учёта регистра, пробелов и
// точки в конце считаются одним пунктом; по организации и по каждому эксперту.
// Скорость и сроки (2.117): сколько дней в среднем от принятия дела экспертом (принял предложение или руководитель передал
// ему дело) до сдачи и сколько дел сдано позже первоначального срока — из них сколько с одобренным переносом срока.
// Сравнение с прошлым месяцем (2.124): у каждого эксперта и в итоге — сколько сдано, из них в срок и сколько раз возвращали
// (руководитель и диспетчер вместе) в прошлом месяце; если прошлый месяц раньше создания организации — сравнения нет.
// Месяц — по московскому времени. Выгрузка таблицей — CSV для Excel (точка с запятой, BOM, суммы с запятой).
import { HttpError } from '../http/core.mjs';
import { splitAmount } from '../money/money.mjs';
import { isOverdue, todayMsk } from '../orders/workflow.mjs';

export const REPORT_MONTHS_BACK = 12;
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const monthRu = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

// Месяцы, за которые можно взять сводку: текущий и 12 прошлых, новые — первыми.
export function reportMonths(today = todayMsk()) {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out = [];
  for (let i = 0; i <= REPORT_MONTHS_BACK; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

export function reportMonth(value, today = todayMsk()) {
  const month = value == null || value === '' ? today.slice(0, 7) : String(value);
  if (!reportMonths(today).includes(month)) {
    throw new HttpError(400, 'bad_month', `Сводка — за текущий месяц и ${REPORT_MONTHS_BACK} прошлых (ГГГГ-ММ)`);
  }
  return month;
}

export const TOP_REMARKS = 5;
export const TOP_REMARKS_EXPERT = 3;
const remarkKey = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[\s.,;:!]+$/, '').trim();

// Самые частые пункты: [{ text, n, experts }] — по убыванию числа, при равенстве — что встречалось позже. Текст — как
// написан в последний раз.
export function topRemarks(items, limit) {
  const groups = new Map();
  for (const it of [...items].sort((a, b) => new Date(b.at) - new Date(a.at))) {
    const key = remarkKey(it.text);
    if (!key) continue;
    const g = groups.get(key) ?? groups.set(key, { text: it.text.trim(), n: 0, experts: new Set(), last: new Date(it.at) }).get(key);
    g.n++;
    g.experts.add(it.user_id);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, limit)
    .map((g) => ({ text: g.text, n: g.n, experts: g.experts.size }));
}

const dayMsk = (t) => todayMsk(new Date(t));
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// Скорость и сроки по сданным делам (2.117): средние дни от принятия до сдачи (до десятых; дела без отметки о принятии —
// не в среднем) и сдано позже первоначального срока — всего и из них с одобренным переносом.
function pace(done) {
  const days = done.filter((o) => o.taken_at).map((o) => Math.max(0, daysBetween(dayMsk(o.taken_at), dayMsk(o.at))));
  const firstLate = done.filter((o) => {
    const first = o.moved_from ?? o.deadline;
    return first && dayMsk(o.at) > first;
  });
  return {
    days_sum: days.reduce((s, d) => s + d, 0),
    days_n: days.length,
    late_first: firstLate.length,
    late_first_moved: firstLate.filter((o) => o.moved_from).length,
  };
}
const avgDays = (p) => (p.days_n ? Math.round((p.days_sum / p.days_n) * 10) / 10 : null);

const feeOf = (o) => (o.payout_kop != null ? Number(o.payout_kop) : o.price_kop ? splitAmount(Number(o.price_kop)).payoutKop : 0);

// Границы месяца по Москве: [начало, начало следующего).
async function monthBounds(sql, month) {
  const [{ start, end }] = await sql`
    select (${`${month}-01`}::date::timestamp at time zone 'Europe/Moscow') as start,
           ((${`${month}-01`}::date + interval '1 month')::timestamp at time zone 'Europe/Moscow') as "end"`;
  return { start, end };
}

// Сданные за месяц (дело впервые перешло в «готово» в этом месяце) экспертами организации — с тех пор, как они в ней.
// Та же выборка — в сводке (2.78) и в архиве заключений за месяц (2.89).
async function orgMonthDone(sql, orgId, ids, { start, end }) {
  if (!ids.length) return [];
  return sql`
      select distinct on (o.id) o.id, o.module, o.service, o.executor_user_id as user_id, o.deadline, o.price_kop,
             p.amount_kop as payout_kop, h.at,
             greatest(
               (select max(f.outcome_at) from order_offers f
                where f.order_id = o.id and f.specialist_id = o.executor_user_id and f.outcome = 'accepted'),
               (select max(a.at) from audit_log a
                where a.subject_type = 'order' and a.subject_id = o.id::text and a.action = 'org.case.transfer'
                  and a.details->>'to' = o.executor_user_id::text)) as taken_at,
             (select to_char(d.old_deadline, 'YYYY-MM-DD') from deadline_requests d
              where d.order_id = o.id and d.outcome = 'approved' order by d.decided_at, d.id limit 1) as moved_from
      from order_status_history h join orders o on o.id = h.order_id
      join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
      left join payouts p on p.order_id = o.id
      where o.executor_user_id = any(${ids}::uuid[]) and h.to_status = 'done'
        and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
      order by o.id, h.at`;
}

// Возвраты за месяц: руководителем (до подписи организации) и диспетчером (на доработку) — по эксперту.
const headReturnsQ = (sql, orgId, ids, { start, end }) => sql`
  select executor_user_id as user_id, count(*)::int as n from org_returns
  where org_id = ${orgId} and executor_user_id = any(${ids}::uuid[]) and created_at >= ${start} and created_at < ${end}
  group by executor_user_id`;
const dispReturnsQ = (sql, orgId, ids, { start, end }) => sql`
  select o.executor_user_id as user_id, count(*)::int as n
  from order_status_history h join orders o on o.id = h.order_id
  join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
  where o.executor_user_id = any(${ids}::uuid[]) and h.from_status = 'review' and h.to_status = 'in_work'
    and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
  group by o.executor_user_id`;

export const prevMonth = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

// Прошлый месяц для сравнения (2.124): { experts: Map(user_id → { done, on_time, returned }), total }.
async function monthCompare(sql, orgId, ids, month) {
  const bounds = await monthBounds(sql, month);
  const [done, head, disp] = ids.length
    ? [await orgMonthDone(sql, orgId, ids, bounds), await headReturnsQ(sql, orgId, ids, bounds), await dispReturnsQ(sql, orgId, ids, bounds)]
    : [[], [], []];
  const n = (rows, u) => rows.find((r) => r.user_id === u)?.n ?? 0;
  const of = (rows, retHead, retDisp) => ({
    done: rows.length,
    on_time: rows.filter((o) => !(o.deadline && dayMsk(o.at) > o.deadline)).length,
    returned: retHead + retDisp,
  });
  const sum = (rows) => rows.reduce((s, r) => s + r.n, 0);
  return {
    experts: new Map(ids.map((u) => [u, of(done.filter((o) => o.user_id === u), n(head, u), n(disp, u))])),
    total: of(done, sum(head), sum(disp)),
  };
}

// Эксперты, которые сейчас работают от организации (выбрана в профиле специалиста и состоят в ней).
async function orgExperts(sql, orgId) {
  return sql`
    select s.user_id, m.created_at as joined_at, u.full_name from specialists s
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = s.user_id
    where s.org_id = ${orgId} order by u.full_name nulls last, s.user_id`;
}

// Дела, сданные экспертами организации за месяц (2.89), — по времени сдачи; с именем эксперта.
export async function orgMonthDoneCases(sql, orgId, month) {
  const experts = await orgExperts(sql, orgId);
  const names = new Map(experts.map((e) => [e.user_id, e.full_name || 'Без имени']));
  const rows = await orgMonthDone(sql, orgId, experts.map((e) => e.user_id), await monthBounds(sql, month));
  return rows.map((o) => ({ ...o, expert_name: names.get(o.user_id) })).sort((a, b) => new Date(a.at) - new Date(b.at));
}

export async function orgMonthReport(sql, orgId, month, today = todayMsk()) {
  const experts = await orgExperts(sql, orgId);
  const ids = experts.map((e) => e.user_id);
  const { start, end } = await monthBounds(sql, month);
  const since = (await sql`select to_char(created_at at time zone 'Europe/Moscow', 'YYYY-MM') as m from organizations
                           where id = ${orgId}`)[0]?.m ?? '';
  const none = { accepted: [], done: [], headReturns: [], remarkItems: [], dispReturns: [], paid: [], active: [] };
  const q = !ids.length ? none : {
    accepted: await sql`
      select f.specialist_id as user_id, count(distinct f.order_id)::int as n from order_offers f
      join org_members m on m.org_id = ${orgId} and m.user_id = f.specialist_id
      where f.specialist_id = any(${ids}::uuid[]) and f.outcome = 'accepted'
        and f.outcome_at >= ${start} and f.outcome_at < ${end} and f.outcome_at >= m.created_at
      group by f.specialist_id`,
    done: await orgMonthDone(sql, orgId, ids, { start, end }),
    headReturns: await headReturnsQ(sql, orgId, ids, { start, end }),
    remarkItems: await sql`
      select r.executor_user_id as user_id, i.text, r.created_at as at from org_returns r
      join org_return_items i on i.return_id = r.id
      where r.org_id = ${orgId} and r.executor_user_id = any(${ids}::uuid[]) and r.created_at >= ${start} and r.created_at < ${end}
      order by r.created_at desc, r.id desc, i.n`,
    dispReturns: await dispReturnsQ(sql, orgId, ids, { start, end }),
    paid: await sql`
      select p.executor_user_id as user_id, coalesce(sum(p.amount_kop), 0)::bigint as kop from payouts p
      join org_members m on m.org_id = ${orgId} and m.user_id = p.executor_user_id
      where p.executor_user_id = any(${ids}::uuid[]) and p.status = 'succeeded'
        and p.paid_at >= ${start} and p.paid_at < ${end} and p.paid_at >= m.created_at
      group by p.executor_user_id`,
    // Просрочено сейчас — только в сводке за текущий месяц: дела в работе, у которых срок уже прошёл.
    active: month === today.slice(0, 7) ? await sql`
      select o.executor_user_id as user_id, o.status, o.deadline from orders o
      join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
      where o.executor_user_id = any(${ids}::uuid[]) and o.status in ('awaiting_executor', 'in_work', 'review') and o.deadline is not null` : [],
  };
  const count = (rows) => new Map(rows.map((r) => [r.user_id, r.n]));
  const accepted = count(q.accepted);
  const headReturns = count(q.headReturns);
  const dispReturns = count(q.dispReturns);
  const paid = new Map(q.paid.map((r) => [r.user_id, Number(r.kop)]));
  const current = month === today.slice(0, 7);
  const prevM = prevMonth(month);
  const cmp = prevM >= since ? await monthCompare(sql, orgId, ids, prevM) : null;
  const rows = experts.map((e) => {
    const done = q.done.filter((o) => o.user_id === e.user_id);
    const p = pace(done);
    return {
      user_id: e.user_id,
      full_name: e.full_name || 'Без имени',
      accepted: accepted.get(e.user_id) ?? 0,
      done: done.length,
      done_late: done.filter((o) => o.deadline && dayMsk(o.at) > o.deadline).length,
      overdue_now: current ? q.active.filter((o) => o.user_id === e.user_id && isOverdue(o, today)).length : null,
      returned_head: headReturns.get(e.user_id) ?? 0,
      returned_dispatcher: dispReturns.get(e.user_id) ?? 0,
      fee_kop: done.reduce((s, o) => s + feeOf(o), 0),
      paid_kop: paid.get(e.user_id) ?? 0,
      avg_days: avgDays(p),
      late_first: p.late_first,
      late_first_moved: p.late_first_moved,
      remarks: topRemarks(q.remarkItems.filter((i) => i.user_id === e.user_id), TOP_REMARKS_EXPERT).map(({ text, n }) => ({ text, n })),
      prev: cmp ? cmp.experts.get(e.user_id) : null,
    };
  });
  const sum = (k) => (k === 'overdue_now' && !current ? null : rows.reduce((s, r) => s + r[k], 0));
  const keys = ['accepted', 'done', 'done_late', 'overdue_now', 'returned_head', 'returned_dispatcher', 'fee_kop', 'paid_kop',
    'late_first', 'late_first_moved'];
  const all = pace(q.done);
  return {
    month,
    month_name: monthRu(month),
    current,
    // Месяцы до создания организации — заведомо пустые (2.90): в выборе только с месяца создания.
    months: reportMonths(today).filter((m) => m >= since || m === month),
    experts: rows,
    total: { ...Object.fromEntries(keys.map((k) => [k, sum(k)])), avg_days: avgDays(all), prev: cmp ? cmp.total : null },
    prev_month: cmp ? prevM : null,
    prev_month_name: cmp ? monthRu(prevM) : null,
    top_remarks: topRemarks(q.remarkItems, TOP_REMARKS),
  };
}

// «Мои итоги за месяц» эксперта (2.92): то же, что строка эксперта в сводке руководителя, но по всем его делам — и частным,
// и от организации; плюс список сданных за месяц дел (своих — с названием), в срок ли и выплачено ли. Месяцы — с того,
// когда человек стал специалистом.
export async function expertMonthReport(sql, userId, month, today = todayMsk()) {
  const { start, end } = await monthBounds(sql, month);
  const since = (await sql`select to_char(created_at at time zone 'Europe/Moscow', 'YYYY-MM') as m from specialists
                           where user_id = ${userId}`)[0]?.m ?? '';
  const current = month === today.slice(0, 7);
  const [{ n: accepted }] = await sql`
    select count(distinct order_id)::int as n from order_offers
    where specialist_id = ${userId} and outcome = 'accepted' and outcome_at >= ${start} and outcome_at < ${end}`;
  const done = await sql`
    select distinct on (o.id) o.id, o.title, o.deadline, o.price_kop, p.amount_kop as payout_kop, p.status as payout_status, h.at
    from order_status_history h join orders o on o.id = h.order_id left join payouts p on p.order_id = o.id
    where o.executor_user_id = ${userId} and h.to_status = 'done' and h.at >= ${start} and h.at < ${end}
    order by o.id, h.at`;
  const [{ n: headReturns }] = await sql`
    select count(*)::int as n from org_returns where executor_user_id = ${userId} and created_at >= ${start} and created_at < ${end}`;
  const [{ n: dispReturns }] = await sql`
    select count(*)::int as n from order_status_history h join orders o on o.id = h.order_id
    where o.executor_user_id = ${userId} and h.from_status = 'review' and h.to_status = 'in_work' and h.at >= ${start} and h.at < ${end}`;
  const [{ kop: paid }] = await sql`
    select coalesce(sum(amount_kop), 0)::bigint as kop from payouts
    where executor_user_id = ${userId} and status = 'succeeded' and paid_at >= ${start} and paid_at < ${end}`;
  const active = current ? await sql`
    select status, deadline from orders
    where executor_user_id = ${userId} and status in ('awaiting_executor', 'in_work', 'review') and deadline is not null` : [];
  const cases = done.sort((a, b) => new Date(a.at) - new Date(b.at)).map((o) => ({
    id: o.id,
    title: o.title,
    deadline: o.deadline,
    done_on: dayMsk(o.at),
    late: !!(o.deadline && dayMsk(o.at) > o.deadline),
    fee_kop: feeOf(o),
    paid: o.payout_status === 'succeeded',
  }));
  const late = cases.filter((c) => c.late).length;
  return {
    month,
    month_name: monthRu(month),
    current,
    months: reportMonths(today).filter((m) => m >= since || m === month),
    total: {
      accepted,
      done: cases.length,
      done_on_time: cases.length - late,
      done_late: late,
      overdue_now: current ? active.filter((o) => isOverdue(o, today)).length : null,
      returned_head: headReturns,
      returned_dispatcher: dispReturns,
      fee_kop: cases.reduce((s, c) => s + c.fee_kop, 0),
      paid_kop: Number(paid),
    },
    cases,
  };
}

// Таблица для Excel: точка с запятой, BOM (иначе Excel путает кодировку), суммы — рубли с запятой. Ячейка, начинающаяся
// с «= + - @», — с апострофом, чтобы Excel не принял имя за формулу.
const rubCell = (kop) => `${Math.floor(kop / 100)},${String(kop % 100).padStart(2, '0')}`;
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportCsv(orgName, r) {
  const head = ['Эксперт', 'Принял дел', 'Сдано (готово)', 'Из них позже срока', ...(r.current ? ['Просрочено сейчас'] : []),
    'Возвращено руководителем', 'Возвращено на доработку', 'Вознаграждение за сданные, ₽', 'Выплачено, ₽',
    'Дней в среднем от принятия до сдачи', 'Позже первоначального срока', 'Из них с переносом срока'];
  const line = (name, x) => [name, x.accepted, x.done, x.done_late, ...(r.current ? [x.overdue_now] : []),
    x.returned_head, x.returned_dispatcher, rubCell(x.fee_kop), rubCell(x.paid_kop),
    x.avg_days == null ? '' : String(x.avg_days).replace('.', ','), x.late_first, x.late_first_moved];
  const day = todayMsk();
  const lines = [
    [`Сводка по экспертам — ${orgName}`],
    [`Месяц: ${r.month_name}${r.current ? ` (по ${Number(day.slice(8, 10))} ${MONTHS_GEN[Number(day.slice(5, 7)) - 1]})` : ''}`],
    [],
    head,
    ...r.experts.map((x) => line(x.full_name, x)),
    line('Итого', r.total),
    ...(r.prev_month ? [[], [`Сравнение с прошлым месяцем (${r.prev_month_name})`, 'Сдано', 'Сдано в прошлом месяце',
      'В срок', 'В срок в прошлом месяце', 'Возвраты', 'Возвраты в прошлом месяце'],
    ...[...r.experts.map((x) => [x.full_name, x]), ['Итого', r.total]].map(([name, x]) => [name, x.done, x.prev.done,
      x.done - x.done_late, x.prev.on_time, x.returned_head + x.returned_dispatcher, x.prev.returned])] : []),
    ...(r.top_remarks?.length ? [[], ['Частые замечания при возврате', 'Сколько раз', 'У скольких экспертов'],
      ...r.top_remarks.map((x) => [x.text, x.n, x.experts])] : []),
  ];
  return `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}
