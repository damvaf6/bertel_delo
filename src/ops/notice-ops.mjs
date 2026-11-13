// Извещение об осмотре (задача 2.470, «Ущерб автомобилю после ДТП»). Эксперт дела, пока дело в работе, записывает, кого
// извещает (страховая, второй участник ДТП — notice.parties в модуле), дату, время и место осмотра, скачивает образец
// Word, отправляет сам и отмечает «извещены, как и когда». Видят все, кто видит дело; пишет только эксперт дела.
// Отмеченные — строкой в раздел «Осмотр» черновика (src/orders/notices.mjs).
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { noticeData, noticeDoc } from '../docs/inspection-notice.mjs';
import { HOW, NAME_MAX, PLACE_MAX, loadNotices, mskParts, noticeLine } from '../orders/notices.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { audit, sendFile, text } from './util.mjs';

// Осмотр — не раньше 60 дней назад (записать забытое) и не дальше года вперёд.
const BACK_DAYS = 60;
const AHEAD_DAYS = 365;
export const NOTICES_MAX = 10;

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
const canWrite = (spec, actor, order) => !!spec && order.status === 'in_work' && isExecutor(actor, order);

function writable(spec, actor, order) {
  if (!spec) throw new HttpError(409, 'not_supported', 'Извещение об осмотре — только для ущерба после ДТП и экспертизы товара');
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Извещение об осмотре ведёт эксперт дела');
  if (order.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Извещение об осмотре — пока дело в работе');
}

// Дата и время осмотра по Москве → момент времени.
export function inspectAt(date, time, today = todayMsk()) {
  const d = String(date ?? '');
  const t = String(time ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) {
    throw new HttpError(400, 'bad_input', 'Укажите дату осмотра');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new HttpError(400, 'bad_input', 'Укажите время осмотра (часы и минуты, например 10:30)');
  if (d < addDays(today, -BACK_DAYS)) throw new HttpError(400, 'bad_input', `Дата осмотра — не раньше ${BACK_DAYS} дней назад`);
  if (d > addDays(today, AHEAD_DAYS)) throw new HttpError(400, 'bad_input', 'Дата осмотра — не дальше года вперёд');
  return new Date(`${d}T${t}:00+03:00`);
}

function item(n, spec) {
  const p = mskParts(n.inspect_at);
  return {
    id: String(n.id), party: n.party, party_name: spec.parties.find((x) => x.id === n.party)?.name ?? n.party,
    name: n.name, date: p.date, time: p.time, place: n.place,
    how: n.how ?? null, how_name: n.how ? HOW[n.how]?.name ?? n.how : null, sent_on: n.sent_on ?? null,
    // Известили позже осмотра — эксперту стоит перенести осмотр или так и написать.
    late: !!n.sent_on && n.sent_on > p.date,
  };
}

export async function noticesView(sql, registry, actor, order) {
  const spec = order.module ? registry.notice(order.module, order.service) : null;
  if (!spec) return { available: false };
  const list = await loadNotices(sql, order.id);
  return {
    available: true, can_write: canWrite(spec, actor, order),
    parties: spec.parties, lead: spec.lead, name_label: spec.name_label, how: Object.entries(HOW).map(([id, h]) => ({ id, name: h.name })),
    name_max: NAME_MAX, place_max: PLACE_MAX, max: NOTICES_MAX,
    notices: list.map((n) => item(n, spec)),
    line: noticeLine(list, spec.parties),
  };
}

async function noticeOf(sql, order, raw) {
  const id = /^\d{1,15}$/.test(String(raw ?? '')) ? String(raw) : null;
  const n = id ? await sql.one`select * from inspection_notices where id = ${id} and order_id = ${order.id}` : null;
  if (!n) throw new HttpError(404, 'not_found', 'Извещение не найдено в этом деле');
  return n;
}

export function noticeOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  const specOf = (registry, order) => (order.module ? registry.notice(order.module, order.service) : null);
  return [
    {
      id: 'notices.list', method: 'GET', path: '/api/orders/:id/notices', auth: 'user', access,
      handler: ({ sql, registry, actor, order }) => noticesView(sql, registry, actor, order),
    },
    {
      // Body: { party, name, date: 'ГГГГ-ММ-ДД', time: 'ЧЧ:ММ', place }.
      id: 'notices.add', method: 'POST', path: '/api/orders/:id/notices', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, res }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const party = String(body?.party ?? '');
        if (!spec.parties.some((p) => p.id === party)) throw new HttpError(400, 'bad_input', 'Выберите, кого извещаете');
        const name = text(body?.name, 'Кому', NAME_MAX);
        const at = inspectAt(body?.date, body?.time);
        const place = text(body?.place, 'Место осмотра', PLACE_MAX);
        await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const [{ n }] = await tx`select count(*)::int as n from inspection_notices where order_id = ${order.id}`;
          if (n >= NOTICES_MAX) throw new HttpError(409, 'too_many', `В деле уже ${NOTICES_MAX} извещений — удалите лишние`);
          const row = await tx.one`insert into inspection_notices (order_id, party, name, inspect_at, place, created_by)
                                   values (${order.id}, ${party}, ${name}, ${at}, ${place}, ${actor.id}) returning id`;
          await audit(tx, actor, 'notices.add', 'order', order.id, { notice: String(row.id), party });
        });
        res.status(201);
        return noticesView(sql, registry, actor, order);
      },
    },
    {
      // «Извещены»: Body { how, sent_on: 'ГГГГ-ММ-ДД' }; { how: null } — снять отметку.
      id: 'notices.mark', method: 'PUT', path: '/api/orders/:id/notices/:n/mark', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, params }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const n = await noticeOf(sql, order, params.n);
        let how = null;
        let sent = null;
        if (body?.how !== null) {
          how = String(body?.how ?? '');
          if (!HOW[how]) throw new HttpError(400, 'bad_input', 'Выберите, как известили');
          sent = String(body?.sent_on ?? '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(sent) || Number.isNaN(Date.parse(`${sent}T00:00:00Z`))) throw new HttpError(400, 'bad_input', 'Укажите, когда известили');
          if (sent > todayMsk()) throw new HttpError(400, 'bad_input', 'Дата извещения — не позже сегодняшней');
          if (sent < addDays(todayMsk(), -BACK_DAYS - 30)) throw new HttpError(400, 'bad_input', 'Дата извещения слишком давняя');
        }
        await sql.tx(async (tx) => {
          await tx`update inspection_notices set how = ${how}, sent_on = ${sent}, marked_at = ${how ? new Date() : null} where id = ${n.id}`;
          await audit(tx, actor, 'notices.mark', 'order', order.id, { notice: String(n.id), how });
        });
        return noticesView(sql, registry, actor, order);
      },
    },
    {
      id: 'notices.delete', method: 'DELETE', path: '/api/orders/:id/notices/:n', auth: 'user', access,
      async handler({ sql, registry, actor, order, params }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const n = await noticeOf(sql, order, params.n);
        await sql.tx(async (tx) => {
          await tx`delete from inspection_notices where id = ${n.id}`;
          await audit(tx, actor, 'notices.delete', 'order', order.id, { notice: String(n.id), party: n.party, marked: !!n.how });
        });
        return noticesView(sql, registry, actor, order);
      },
    },
    {
      // Образец Word — видят все стороны дела.
      id: 'notices.doc', method: 'GET', path: '/api/orders/:id/notices/:n/doc', auth: 'user', access,
      async handler({ sql, registry, actor, order, params, providers, res }) {
        const spec = specOf(registry, order);
        if (!spec) throw new HttpError(409, 'not_supported', 'Извещение об осмотре — только для ущерба после ДТП и экспертизы товара');
        const n = await noticeOf(sql, order, params.n);
        const [ex] = order.executor_user_id ? await sql`select full_name from users where id = ${order.executor_user_id}` : [];
        const def = registry.service(order.module, order.service);
        const data = noticeData({ order, def, spec, n, executor: ex?.full_name });
        await audit(sql, actor, 'notices.doc', 'order', order.id, { notice: String(n.id) });
        return sendFile(res, providers, { ...noticeDoc(data), mime: DOCX_MIME });
      },
    },
  ];
}
