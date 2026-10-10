// Перенос срока дела (задача 2.91). Исполнитель просит новую дату с причиной, пока дело в работе; диспетчер соглашается
// или отказывает одной кнопкой (с пояснением по желанию). Согласие меняет срок заявки — «Сегодня», сводка руководителя,
// «позже срока» и напоминания (src/notify/reminders.mjs, по новому сроку) сразу считают по новой дате. Заказчик видит
// просьбу и ответ; история переносов — в деле (все просьбы) и в журнале. Открытая просьба на дело одна.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { BUSY_DEADLINES } from '../orders/schedule.mjs';
import { yearStats } from '../matching/stats.mjs';
import { customersOf, dispatchers, notify } from '../notify/notify.mjs';
import { audit, text } from './util.mjs';
import { moveDeadlineNotes } from './note-ops.mjs';

const MAX_DAYS = 730; // как у срока заявки — не дальше двух лет
const DECIDE_STATUSES = ['in_work', 'review'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function newDateFrom(value, order) {
  const v = String(value ?? '');
  const d = new Date(`${v}T00:00:00Z`);
  if (!DATE_RE.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, 'bad_date', 'Укажите новую дату срока');
  }
  if (v <= order.deadline) throw new HttpError(400, 'not_later', 'Новый срок должен быть позже нынешнего');
  if (v > addDays(todayMsk(), MAX_DAYS)) throw new HttpError(400, 'deadline_far', 'Срок — не дальше двух лет');
  return v;
}

async function openOf(sql, order, raw) {
  const id = String(raw ?? '');
  const r = /^\d{1,18}$/.test(id) ? await sql.one`select * from deadline_requests where id = ${id} and order_id = ${order.id}` : null;
  if (!r) throw new HttpError(404, 'not_found', 'Просьба о переносе срока не найдена');
  if (r.outcome) throw new HttpError(409, 'already_decided', 'По этой просьбе уже есть ответ — обновите страницу');
  return r;
}

// Готовые причины переноса (2.126): исполнителю одной кнопкой, текст можно поправить. «Жду документы» — только если у
// заказчика есть невыполненный запрос документов (дата первого запроса и что просили — из дела, новый срок — на столько
// дней позже, сколько ждёт); «Осмотр перенесён владельцем» — если у услуги есть осмотр или в деле была ссылка либо выезд.
const MAX_TITLES = 3;
async function presetReasons(sql, order, registry) {
  const out = [];
  const docs = await sql`select title, to_char(requested_at at time zone 'Europe/Moscow', 'DD.MM.YYYY') as day,
                                ((now() at time zone 'Europe/Moscow')::date - (requested_at at time zone 'Europe/Moscow')::date) as waited
                         from doc_requests where order_id = ${order.id} and fulfilled_at is null and cancelled_at is null order by id`;
  if (docs.length) {
    const titles = docs.slice(0, MAX_TITLES).map((d) => d.title).join(', ');
    const more = docs.length > MAX_TITLES ? ` и ещё ${docs.length - MAX_TITLES}` : '';
    out.push({
      id: 'docs', label: `Жду документы с ${docs[0].day}`,
      reason: `Жду документы от заказчика с ${docs[0].day}: ${titles}${more}`.slice(0, 1000),
      new_deadline: addDays(order.deadline, Math.max(1, docs[0].waited)),
    });
  }
  // «Много дел в этот день» (2.134): у исполнителя в день срока больше двух дел к сдаче (число — только в подписи кнопки,
  // в причину, которую видит заказчик, не идёт). Новый срок — ближайший будний
  // день после срока, где к сдаче меньше двух дел (с этим делом будет не больше двух); ищем на две недели вперёд.
  const due = await sql`select to_char(deadline, 'YYYY-MM-DD') as day, count(*)::int as n from orders
                        where executor_user_id = ${order.executor_user_id} and status in ('awaiting_executor', 'in_work')
                          and deadline between ${order.deadline}::date and ${addDays(order.deadline, 14)}::date
                        group by deadline`;
  const per = new Map(due.map((r) => [r.day, r.n]));
  const n = per.get(order.deadline) ?? 0;
  if (n > BUSY_DEADLINES) {
    let next = null;
    for (let i = 1; i <= 14 && !next; i++) {
      const d = addDays(order.deadline, i);
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6 && (per.get(d) ?? 0) < BUSY_DEADLINES) next = d;
    }
    const [y, m, d] = order.deadline.split('-');
    out.push({ id: 'busy', label: `Много дел в этот день (${n})`, reason: `Высокая загрузка: на ${d}.${m}.${y} у меня к сдаче несколько дел — прошу перенести срок`,
      ...(next ? { new_deadline: next } : {}) });
  }
  const steps = registry?.inspectionSteps(order.module, order.service) ?? [];
  const [had] = await sql`select (exists (select 1 from inspection_links where order_id = ${order.id})
                                  or exists (select 1 from onsite_visits where order_id = ${order.id})) as yes`;
  if (steps.length || had.yes) out.push({ id: 'inspection', label: 'Осмотр перенесён владельцем', reason: 'Осмотр объекта перенесён владельцем' });
  return out;
}

// Свой темп (2.145): исполнителю дела в работе — сколько дней до срока и сколько у него обычно занимает такая услуга (средний
// из «Сдано за год», 2.139: от принятия до «готово»; нужно хотя бы два сданных дела этой услуги). Сколько дней дело уже у
// него — от принятия предложения или передачи ему руководителем, как в 2.139. Обычно нужно ещё больше, чем осталось до
// срока, — `late` (мягкое предупреждение, решает сам исполнитель). Видит только исполнитель: это его собственные цифры.
const PACE_MIN_DONE = 2;
async function paceOf(sql, order, registry) {
  const today = todayMsk();
  const daysLeft = Math.round((Date.parse(order.deadline) - Date.parse(today)) / 86_400_000);
  const year = await yearStats(sql, order.executor_user_id, { today, registry });
  const same = year.by_service.find((s) => s.module === order.module && s.service === order.service);
  const out = { days_left: daysLeft, usual_days: null, done: same?.done ?? 0, spent_days: null, need_days: null, late: false };
  if (!same || same.done < PACE_MIN_DONE || same.avg_days == null) return out;
  const [t] = await sql`
    select to_char(greatest(
      (select max(f.outcome_at) from order_offers f
       where f.order_id = ${order.id} and f.specialist_id = ${order.executor_user_id} and f.outcome = 'accepted'),
      (select max(a.at) from audit_log a
       where a.subject_type = 'order' and a.subject_id = ${order.id}::text and a.action = 'org.case.transfer'
         and a.details->>'to' = ${order.executor_user_id}::text)) at time zone 'Europe/Moscow', 'YYYY-MM-DD') as taken_day`;
  const spent = t?.taken_day ? Math.max(0, Math.round((Date.parse(today) - Date.parse(t.taken_day)) / 86_400_000)) : null;
  const need = Math.max(0, Math.ceil(same.avg_days - (spent ?? 0)));
  return { ...out, usual_days: same.avg_days, spent_days: spent, need_days: need, late: need > Math.max(0, daysLeft) };
}

// Ответ диспетчера, который исполнитель ещё не видел (2.155): согласие или отказ по последней просьбе — заметно в «Сроке»
// (один раз: открыл блок — увидел) и строкой в «Сегодня» (answeredExtends). Видит нынешний исполнитель дела — и тогда, когда
// просьбу подавал прежний эксперт, а новый её оставил (2.114).
async function freshAnswer(sql, actor, order) {
  if (order.executor_user_id !== actor.id) return null;
  const r = await sql.one`
    update deadline_requests set seen_at = now()
    where id = (select id from deadline_requests where order_id = ${order.id} and outcome is not null order by decided_at desc, id desc limit 1)
      and outcome in ('approved', 'declined') and seen_at is null
    returning id, outcome, to_char(old_deadline, 'YYYY-MM-DD') as old_deadline, to_char(new_deadline, 'YYYY-MM-DD') as new_deadline,
              answer, decided_at`;
  return r ? { ...r, id: String(r.id) } : null;
}

async function view(sql, actor, order, registry) {
  const sides = orderSides(actor, order);
  const fresh = await freshAnswer(sql, actor, order);
  const rows = await sql`
    select id, old_deadline, new_deadline, reason, requested_at, outcome, decided_at, answer from deadline_requests where order_id = ${order.id} order by id desc`;
  const requests = rows.map((r) => ({ ...r, id: String(r.id) }));
  const open = requests.find((r) => !r.outcome) ?? null;
  const canRequest = sides.includes('executor') && order.status === 'in_work' && !!order.deadline && !open;
  return {
    deadline: order.deadline,
    fresh_answer: fresh,
    requests,
    open,
    can_request: canRequest,
    reasons: canRequest ? await presetReasons(sql, order, registry) : [],
    can_withdraw: !!open && sides.includes('executor'),
    can_decide: !!open && sides.includes('dispatcher') && DECIDE_STATUSES.includes(order.status),
    pace: sides.includes('executor') && order.status === 'in_work' && order.deadline ? await paceOf(sql, order, registry) : null,
  };
}

// Открытые просьбы о переносе по делам (2.100): эксперту и руководителю в «Сегодня» и «Делах экспертов» — на какую дату
// просят, пока диспетчер не ответил. Только дата: причину пишет эксперт про заказчика, руководителю она не показывается.
export async function openExtends(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`select order_id, to_char(new_deadline, 'YYYY-MM-DD') as new_deadline, requested_at from deadline_requests
                         where outcome is null and order_id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.order_id, { new_deadline: r.new_deadline, requested_at: r.requested_at }]));
}

// Ответы диспетчера, которые исполнитель ещё не видел (2.155) — эксперту в «Сегодня»: согласился (новый срок) или отказал и
// почему. Последний ответ по каждому делу; строка уходит, когда эксперт откроет дело (блок «Срок»).
export async function answeredExtends(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`
    select distinct on (order_id) order_id, outcome, to_char(old_deadline, 'YYYY-MM-DD') as old_deadline,
           to_char(new_deadline, 'YYYY-MM-DD') as new_deadline, answer, decided_at, seen_at
    from deadline_requests where order_id = any(${ids}::uuid[]) and outcome is not null
    order by order_id, decided_at desc, id desc`;
  return new Map(rows.filter((r) => ['approved', 'declined'].includes(r.outcome) && !r.seen_at)
    .map(({ seen_at: _, ...r }) => [r.order_id, r]));
}

export function deadlineOps() {
  return [
    {
      id: 'deadline_requests.list', method: 'GET', path: '/api/orders/:id/deadline-requests', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) { return view(sql, actor, order, registry); },
    },
    {
      // Исполнитель просит перенести срок: новая дата (позже нынешней) и причина. Диспетчерам — уведомление.
      id: 'deadline_requests.create', method: 'POST', path: '/api/orders/:id/deadline-requests', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body, res, registry }) {
        if (!orderSides(actor, order).includes('executor')) throw new HttpError(403, 'forbidden', 'Перенести срок просит исполнитель дела');
        if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Перенос срока просят, пока дело в работе');
        if (!order.deadline) throw new HttpError(409, 'no_deadline', 'У заявки нет срока');
        if (body?.from !== undefined && body.from !== order.deadline) throw new HttpError(409, 'status_changed', 'Срок уже изменился — обновите страницу');
        const to = newDateFrom(body?.new_deadline, order);
        const reason = text(body?.reason, 'Причина переноса', 1000);
        await sql.tx(async (tx) => {
          const made = await tx`insert into deadline_requests (order_id, requested_by, old_deadline, new_deadline, reason)
                                values (${order.id}, ${actor.id}, ${order.deadline}, ${to}, ${reason})
                                on conflict do nothing returning id`;
          if (!made.length) throw new HttpError(409, 'already_requested', 'Просьба о переносе уже ждёт ответа диспетчера');
          await audit(tx, actor, 'deadline.request', 'order', order.id, { from: order.deadline, to, reason });
          await notify(tx, 'deadline_ext_requested', { users: await dispatchers(tx), orderId: order.id, actor });
        });
        res.status(201);
        return view(sql, actor, order, registry);
      },
    },
    {
      // Исполнитель отзывает свою просьбу, пока нет ответа.
      id: 'deadline_requests.withdraw', method: 'DELETE', path: '/api/orders/:id/deadline-requests/:rid', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params, registry }) {
        if (!orderSides(actor, order).includes('executor')) throw new HttpError(403, 'forbidden', 'Отозвать просьбу может исполнитель дела');
        const r = await openOf(sql, order, params.rid);
        await sql.tx(async (tx) => {
          await tx`update deadline_requests set outcome = 'withdrawn', decided_by = ${actor.id}, decided_at = now()
                   where id = ${r.id} and outcome is null`;
          await audit(tx, actor, 'deadline.withdraw', 'order', order.id, { to: r.new_deadline });
        });
        return view(sql, actor, order, registry);
      },
    },
    {
      // Диспетчер: согласиться (срок заявки меняется) или отказать. Пояснение — по желанию.
      id: 'deadline_requests.decide', method: 'POST', path: '/api/orders/:id/deadline-requests/:rid/decide', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params, body, registry }) {
        if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Решает диспетчер');
        if (!DECIDE_STATUSES.includes(order.status)) throw new HttpError(409, 'order_final', 'Дело уже не в работе — срок не переносится');
        const r = await openOf(sql, order, params.rid);
        const approve = body?.approve === true;
        if (!approve && body?.approve !== false) throw new HttpError(400, 'bad_input', 'Согласиться или отказать?');
        const answer = body?.answer && String(body.answer).trim() ? text(body.answer, 'Пояснение', 1000) : null;
        const { old_deadline: oldDeadline, new_deadline: newDeadline } = r;
        if (approve && oldDeadline !== order.deadline) throw new HttpError(409, 'status_changed', 'Срок заявки уже изменился — обновите страницу');
        await sql.tx(async (tx) => {
          const done = await tx`update deadline_requests set outcome = ${approve ? 'approved' : 'declined'}, decided_by = ${actor.id},
                                       decided_at = now(), answer = ${answer}
                                where id = ${r.id} and outcome is null returning id`;
          if (!done.length) throw new HttpError(409, 'already_decided', 'По этой просьбе уже есть ответ — обновите страницу');
          if (approve) {
            const moved = await tx`update orders set deadline = ${newDeadline}, updated_at = now()
                                   where id = ${order.id} and deadline = ${oldDeadline}::date returning id`;
            if (!moved.length) throw new HttpError(409, 'status_changed', 'Срок заявки уже изменился — обновите страницу');
            await moveDeadlineNotes(tx, order.id, newDeadline);
          }
          await audit(tx, actor, approve ? 'deadline.approve' : 'deadline.decline', 'order', order.id,
            { from: oldDeadline, to: newDeadline, answer });
          const executor = order.executor_user_id ? [order.executor_user_id] : [];
          await notify(tx, approve ? 'deadline_ext_approved' : 'deadline_ext_declined', { users: executor, orderId: order.id, actor });
          if (approve) await notify(tx, 'deadline_moved', { users: await customersOf(tx, order), orderId: order.id, actor });
        });
        return view(sql, actor, { ...order, deadline: approve ? newDeadline : order.deadline }, registry);
      },
    },
  ];
}
