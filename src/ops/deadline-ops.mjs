// Перенос срока дела (задача 2.91). Исполнитель просит новую дату с причиной, пока дело в работе; диспетчер соглашается
// или отказывает одной кнопкой (с пояснением по желанию). Согласие меняет срок заявки — «Сегодня», сводка руководителя,
// «позже срока» и напоминания (src/notify/reminders.mjs, по новому сроку) сразу считают по новой дате. Заказчик видит
// просьбу и ответ; история переносов — в деле (все просьбы) и в журнале. Открытая просьба на дело одна.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { customersOf, dispatchers, notify } from '../notify/notify.mjs';
import { audit, text } from './util.mjs';

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
  const steps = registry?.inspectionSteps(order.module, order.service) ?? [];
  const [had] = await sql`select (exists (select 1 from inspection_links where order_id = ${order.id})
                                  or exists (select 1 from onsite_visits where order_id = ${order.id})) as yes`;
  if (steps.length || had.yes) out.push({ id: 'inspection', label: 'Осмотр перенесён владельцем', reason: 'Осмотр объекта перенесён владельцем' });
  return out;
}

async function view(sql, actor, order, registry) {
  const sides = orderSides(actor, order);
  const rows = await sql`
    select id, old_deadline, new_deadline, reason, requested_at, outcome, decided_at, answer from deadline_requests where order_id = ${order.id} order by id desc`;
  const requests = rows.map((r) => ({ ...r, id: String(r.id) }));
  const open = requests.find((r) => !r.outcome) ?? null;
  const canRequest = sides.includes('executor') && order.status === 'in_work' && !!order.deadline && !open;
  return {
    deadline: order.deadline,
    requests,
    open,
    can_request: canRequest,
    reasons: canRequest ? await presetReasons(sql, order, registry) : [],
    can_withdraw: !!open && sides.includes('executor'),
    can_decide: !!open && sides.includes('dispatcher') && DECIDE_STATUSES.includes(order.status),
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
