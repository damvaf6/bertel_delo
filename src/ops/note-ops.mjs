// Заметки эксперта к делу (задача 2.115): свои записи исполнителя («уточнить этаж у заказчика»). Видит и пишет только
// исполнитель дела, и только свои: заказчик, диспетчер, руководитель организации и следующий эксперт после передачи их не
// видят. По желанию — «Напомнить» на дату: в этот день одно уведомление в ленту (раз в минуту вместе с напоминаниями о
// сроках, src/server.mjs) и строка в «Сегодня», пока заметка не отмечена «сделано». В уведомлении и СМС текста заметки
// нет — только номер заявки. В журнал дела заметки не попадают (их не видят даже служебные).
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { notify } from '../notify/notify.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { text } from './util.mjs';

const OPEN = ['awaiting_executor', 'in_work', 'review', 'done']; // писать и получать напоминание можно, пока дело не закрыто
const MAX_NOTES = 50;
const MAX_AHEAD = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');

function remindFrom(value, today) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value);
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new HttpError(400, 'bad_date', 'Неверная дата напоминания');
  if (v < today) throw new HttpError(400, 'bad_date', 'Дата напоминания уже прошла — выберите сегодня или позже');
  if (v > addDays(today, MAX_AHEAD)) throw new HttpError(400, 'bad_date', 'Напоминание — не дальше чем через год');
  return v;
}

const noteId = (v) => (/^\d{1,18}$/.test(String(v ?? '')) ? String(v) : '0');

export async function ownNotes(sql, orderId, userId) {
  const rows = await sql`select id, body, to_char(remind_on, 'YYYY-MM-DD') as remind_on, reminded_at, done_at, created_at, updated_at
                         from order_notes where order_id = ${orderId} and author_id = ${userId} and deleted_at is null
                         order by done_at is not null, remind_on nulls last, id desc`;
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

// Заметки с напоминанием на сегодня и раньше, не отмеченные «сделано» — эксперту в «Сегодня».
export async function dueNotes(sql, userId, orderIds, today = todayMsk()) {
  if (!orderIds.length) return [];
  const rows = await sql`select id, order_id, body, to_char(remind_on, 'YYYY-MM-DD') as remind_on from order_notes
                         where author_id = ${userId} and order_id = any(${orderIds}::uuid[]) and deleted_at is null and done_at is null
                           and remind_on <= ${today}::date order by remind_on, id`;
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

async function view(sql, actor, order) {
  if (!isExecutor(actor, order)) return { available: false };
  return { available: true, can_write: OPEN.includes(order.status), today: todayMsk(), notes: await ownNotes(sql, order.id, actor.id) };
}

// Напоминания по заметкам: в день remind_on (или позже, если сервер стоял) — одно уведомление автору, пока он исполнитель
// дела и дело не закрыто. Перенёс дату — придёт снова (reminded_at сбрасывается при правке даты).
export async function remindNotes(sql, { today = todayMsk() } = {}) {
  const rows = await sql`select n.id, n.order_id, n.author_id from order_notes n join orders o on o.id = n.order_id
                         where n.reminded_at is null and n.done_at is null and n.deleted_at is null and n.remind_on <= ${today}::date
                           and o.executor_user_id = n.author_id and o.status = any(${OPEN})`;
  let sent = 0;
  for (const r of rows) {
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`update order_notes set reminded_at = now() where id = ${r.id} and reminded_at is null returning id`;
      if (!fresh.length) return 0;
      return notify(tx, 'note_reminder', { users: [r.author_id], orderId: r.order_id });
    });
  }
  return sent;
}

export function noteOps() {
  const writable = (actor, order) => {
    if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Заметки к делу ведёт исполнитель дела');
    if (!OPEN.includes(order.status)) throw new HttpError(409, 'status_changed', 'Дело закрыто — заметки только для чтения');
  };
  return [
    {
      id: 'notes.list', method: 'GET', path: '/api/orders/:id/notes', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) { return view(sql, actor, order); },
    },
    {
      id: 'notes.create', method: 'POST', path: '/api/orders/:id/notes', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body, res }) {
        writable(actor, order);
        const note = text(body?.body, 'Заметка', 1000);
        const remindOn = remindFrom(body?.remind_on, todayMsk());
        const n = await sql.one`select count(*)::int as n from order_notes where order_id = ${order.id} and author_id = ${actor.id} and deleted_at is null`;
        if (n.n >= MAX_NOTES) throw new HttpError(409, 'too_many', `Заметок к делу — не больше ${MAX_NOTES}: удалите ненужные`);
        await sql`insert into order_notes (order_id, author_id, body, remind_on) values (${order.id}, ${actor.id}, ${note}, ${remindOn})`;
        res.status(201);
        return view(sql, actor, order);
      },
    },
    {
      // Правка: текст, дата напоминания (null — без напоминания), «сделано» (done: true/false).
      id: 'notes.update', method: 'PATCH', path: '/api/orders/:id/notes/:nid', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params, body }) {
        writable(actor, order);
        const cur = await sql.one`select id, body, to_char(remind_on, 'YYYY-MM-DD') as remind_on, done_at from order_notes
                                  where id = ${noteId(params.nid)} and order_id = ${order.id} and author_id = ${actor.id} and deleted_at is null`;
        if (!cur) throw new HttpError(404, 'not_found', 'Заметка не найдена — обновите страницу');
        const note = body?.body !== undefined ? text(body.body, 'Заметка', 1000) : cur.body;
        const remindOn = body?.remind_on !== undefined
          ? (body.remind_on === cur.remind_on ? cur.remind_on : remindFrom(body.remind_on, todayMsk())) : cur.remind_on;
        if (body?.done !== undefined && typeof body.done !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Сделано»: да или нет');
        const done = body?.done === undefined ? !!cur.done_at : body.done;
        const moved = remindOn !== cur.remind_on;
        await sql`update order_notes set body = ${note}, remind_on = ${remindOn}, updated_at = now(),
                    done_at = ${done ? (cur.done_at ?? new Date()) : null},
                    reminded_at = case when ${moved} then null else reminded_at end
                  where id = ${cur.id}`;
        return view(sql, actor, order);
      },
    },
    {
      id: 'notes.delete', method: 'DELETE', path: '/api/orders/:id/notes/:nid', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params }) {
        writable(actor, order);
        const done = await sql`update order_notes set deleted_at = now() where id = ${noteId(params.nid)} and order_id = ${order.id}
                                 and author_id = ${actor.id} and deleted_at is null returning id`;
        if (!done.length) throw new HttpError(404, 'not_found', 'Заметка не найдена — обновите страницу');
        return view(sql, actor, order);
      },
    },
  ];
}
