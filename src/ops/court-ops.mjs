// Вызов эксперта в суд (задача 2.441). После «готово» заказчик или диспетчер пишет, что эксперта вызывают на заседание:
// суд, номер дела, дата и время, адрес и файл повестки или определения. Дело не переоткрывается (статус прежний), эксперту —
// уведомление. Вызовов может быть несколько (заседание отложили — новый вызов). Видят все, кто видит дело.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { notify } from '../notify/notify.mjs';
import { todayMsk, addDays } from '../orders/workflow.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit, text, uuidFrom } from './util.mjs';

// Вызывают после сдачи: дело готово или уже закрыто.
const AFTER = ['done', 'closed'];
const MAX_FILE_BYTES = 3 * 1024 * 1024;
// Заседание — не раньше сегодняшнего дня и не дальше двух лет.
const AHEAD_DAYS = 730;
export const COURT_MAX = 200;
export const CASE_NO_MAX = 60;
export const ADDRESS_MAX = 300;

// Сторона, от которой пишут о вызове: заказчик или диспетчер; иначе — нельзя.
function callSide(actor, order) {
  const sides = orderSides(actor, order);
  return ['customer', 'dispatcher'].find((s) => sides.includes(s)) ?? null;
}

function canCall(registry, actor, order) {
  return registry.court(order.module) && AFTER.includes(order.status) && !!order.executor_user_id && !!callSide(actor, order);
}

function writable(registry, actor, order) {
  if (!registry.court(order.module)) throw new HttpError(409, 'not_supported', 'Вызов в суд — только для экспертизы');
  if (!callSide(actor, order)) throw new HttpError(403, 'forbidden', 'О вызове в суд пишет заказчик или диспетчер');
  if (!AFTER.includes(order.status)) throw new HttpError(409, 'status_changed', 'О вызове в суд пишут после того, как отчёт сдан');
  if (!order.executor_user_id) throw new HttpError(409, 'no_executor', 'У дела нет эксперта');
}

// Дата и время заседания по Москве → момент времени. Дата — ГГГГ-ММ-ДД, время — ЧЧ:ММ.
export function hearingAt(date, time, today = todayMsk()) {
  const d = String(date ?? '');
  const t = String(time ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) {
    throw new HttpError(400, 'bad_input', 'Укажите дату заседания');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new HttpError(400, 'bad_input', 'Укажите время заседания (часы и минуты)');
  if (d < today) throw new HttpError(400, 'bad_input', 'Дата заседания уже прошла');
  if (d > addDays(today, AHEAD_DAYS)) throw new HttpError(400, 'bad_input', 'Дата заседания — не дальше двух лет');
  return new Date(`${d}T${t}:00+03:00`);
}

async function calls(sql, order) {
  const rows = await sql`
    select c.id, c.court, c.case_no, c.hearing_at, c.address, c.side, c.created_at, d.id as doc_id, d.filename
    from court_calls c left join documents d on d.id = c.document_id and d.deleted_at is null
    where c.order_id = ${order.id} order by c.hearing_at, c.id`;
  return rows.map((r) => ({
    id: String(r.id), court: r.court, case_no: r.case_no, hearing_at: r.hearing_at, address: r.address, side: r.side,
    created_at: r.created_at, document: r.doc_id ? { id: r.doc_id, filename: r.filename } : null,
  }));
}

async function view(sql, registry, actor, order) {
  if (!registry.court(order.module)) return { available: false };
  const list = await calls(sql, order);
  const now = Date.now();
  return { available: true, can_add: canCall(registry, actor, order), calls: list,
           next: list.find((c) => new Date(c.hearing_at).getTime() >= now - 3 * 3600 * 1000)?.id ?? null };
}

export function courtOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  return [
    {
      id: 'court.calls', method: 'GET', path: '/api/orders/:id/court', auth: 'user', access,
      async handler({ sql, registry, actor, order }) { return view(sql, registry, actor, order); },
    },
    {
      // Файл повестки или определения — до записи вызова (у закрытого дела обычная загрузка файлов закрыта).
      id: 'court.file', method: 'POST', path: '/api/orders/:id/court/file', auth: 'user', access,
      body: 'raw', limit: MAX_FILE_BYTES,
      async handler(ctx) {
        const { req, body, registry, actor, order, res } = ctx;
        writable(registry, actor, order);
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
        let filename;
        try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
        const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
        const doc = await saveDocument(ctx, { filename, mime, buf: body, kind: 'other' });
        res.status(201);
        return { document: publicDoc(doc) };
      },
    },
    {
      id: 'court.add', method: 'POST', path: '/api/orders/:id/court', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, res }) {
        writable(registry, actor, order);
        const court = text(body?.court, 'Суд', COURT_MAX);
        const caseNo = text(body?.case_no, 'Номер дела', CASE_NO_MAX);
        const at = hearingAt(body?.date, body?.time);
        const address = text(body?.address, 'Адрес суда', ADDRESS_MAX);
        let docId = null;
        if (body?.document_id) {
          docId = uuidFrom(body.document_id, 'Файл повестки не найден');
          const d = await sql.one`select 1 from documents where id = ${docId} and order_id = ${order.id} and kind <> 'result' and deleted_at is null`;
          if (!d) throw new HttpError(404, 'not_found', 'Файл повестки не найден в этом деле');
        }
        const side = callSide(actor, order);
        const row = await sql.tx(async (tx) => {
          const c = await tx.one`insert into court_calls (order_id, court, case_no, hearing_at, address, document_id, created_by, side)
                                 values (${order.id}, ${court}, ${caseNo}, ${at}, ${address}, ${docId}, ${actor.id}, ${side}) returning id`;
          await audit(tx, actor, 'court.add', 'order', order.id, { call: String(c.id), side, hearing_at: at.toISOString(), ...(docId ? { document: docId } : {}) });
          await notify(tx, 'court_call', { users: [order.executor_user_id], orderId: order.id, actor });
          return c;
        });
        res.status(201);
        return { id: String(row.id), ...(await view(sql, registry, actor, order)) };
      },
    },
  ];
}
