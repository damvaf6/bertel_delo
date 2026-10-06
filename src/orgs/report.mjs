// Сводка руководителю за месяц по экспертам (2.78): сколько дел каждый принял, сдал (готово), из них позже срока, сколько
// раз возвращали (руководитель — до подписи организации, диспетчер — на доработку), вознаграждение за сданные и выплачено.
// Считается только то, что было с тех пор, как эксперт состоит в организации, — прошлые частные дела руководитель не видит.
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

const dayMsk = (t) => todayMsk(new Date(t));
const feeOf = (o) => (o.payout_kop != null ? Number(o.payout_kop) : o.price_kop ? splitAmount(Number(o.price_kop)).payoutKop : 0);

export async function orgMonthReport(sql, orgId, month, today = todayMsk()) {
  const experts = await sql`
    select s.user_id, m.created_at as joined_at, u.full_name from specialists s
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = s.user_id
    where s.org_id = ${orgId} order by u.full_name nulls last, s.user_id`;
  const ids = experts.map((e) => e.user_id);
  // Границы месяца по Москве: [начало, начало следующего).
  const [{ start, end }] = await sql`
    select (${`${month}-01`}::date::timestamp at time zone 'Europe/Moscow') as start,
           ((${`${month}-01`}::date + interval '1 month')::timestamp at time zone 'Europe/Moscow') as "end"`;
  const none = { accepted: [], done: [], headReturns: [], dispReturns: [], paid: [], active: [] };
  const q = !ids.length ? none : {
    accepted: await sql`
      select f.specialist_id as user_id, count(distinct f.order_id)::int as n from order_offers f
      join org_members m on m.org_id = ${orgId} and m.user_id = f.specialist_id
      where f.specialist_id = any(${ids}::uuid[]) and f.outcome = 'accepted'
        and f.outcome_at >= ${start} and f.outcome_at < ${end} and f.outcome_at >= m.created_at
      group by f.specialist_id`,
    done: await sql`
      select distinct on (o.id) o.id, o.executor_user_id as user_id, o.deadline, o.price_kop, p.amount_kop as payout_kop, h.at
      from order_status_history h join orders o on o.id = h.order_id
      join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
      left join payouts p on p.order_id = o.id
      where o.executor_user_id = any(${ids}::uuid[]) and h.to_status = 'done'
        and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
      order by o.id, h.at`,
    headReturns: await sql`
      select executor_user_id as user_id, count(*)::int as n from org_returns
      where org_id = ${orgId} and executor_user_id = any(${ids}::uuid[]) and created_at >= ${start} and created_at < ${end}
      group by executor_user_id`,
    dispReturns: await sql`
      select o.executor_user_id as user_id, count(*)::int as n
      from order_status_history h join orders o on o.id = h.order_id
      join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
      where o.executor_user_id = any(${ids}::uuid[]) and h.from_status = 'review' and h.to_status = 'in_work'
        and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
      group by o.executor_user_id`,
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
  const rows = experts.map((e) => {
    const done = q.done.filter((o) => o.user_id === e.user_id);
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
    };
  });
  const sum = (k) => (k === 'overdue_now' && !current ? null : rows.reduce((s, r) => s + r[k], 0));
  const keys = ['accepted', 'done', 'done_late', 'overdue_now', 'returned_head', 'returned_dispatcher', 'fee_kop', 'paid_kop'];
  return {
    month,
    month_name: monthRu(month),
    current,
    months: reportMonths(today),
    experts: rows,
    total: Object.fromEntries(keys.map((k) => [k, sum(k)])),
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
    'Возвращено руководителем', 'Возвращено на доработку', 'Вознаграждение за сданные, ₽', 'Выплачено, ₽'];
  const line = (name, x) => [name, x.accepted, x.done, x.done_late, ...(r.current ? [x.overdue_now] : []),
    x.returned_head, x.returned_dispatcher, rubCell(x.fee_kop), rubCell(x.paid_kop)];
  const day = todayMsk();
  const lines = [
    [`Сводка по экспертам — ${orgName}`],
    [`Месяц: ${r.month_name}${r.current ? ` (по ${Number(day.slice(8, 10))} ${MONTHS_GEN[Number(day.slice(5, 7)) - 1]})` : ''}`],
    [],
    head,
    ...r.experts.map((x) => line(x.full_name, x)),
    line('Итого', r.total),
  ];
  return `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}
