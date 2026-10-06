// Запрос недостающих документов (задача 2.64). Исполнитель одной кнопкой просит у заказчика документы из списка услуги
// (описание модуля, request_docs: выписка ЕГРН, ПТС, чек…) или своими словами; заказчику — уведомление (и письмо, если
// заявка пришла по письму). Заказчик видит список с отметками и загружает файл к каждому — исполнителю уведомление.
// Видят запрос все, кто видит заявку; просит и снимает просьбу только исполнитель, пока дело в работе; файл прикладывает
// заказчик (тот, кто может добавлять документы заявки). Удалённый заказчиком файл — просьба снова открыта (core-ops.mjs).
import { HttpError } from '../http/core.mjs';
import { FINAL } from '../orders/workflow.mjs';
import { LEVEL, orderLevel, orderSides } from '../access/policy.mjs';
import { customersOf, notify } from '../notify/notify.mjs';
import { audit, text, uuidFrom } from './util.mjs';

const MAX_CUSTOM = 5;
const MAX_OPEN = 30;

const isExecutor = (actor, order) => orderSides(actor, order).includes('executor');

function executorOnly(actor, order) {
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Документы запрашивает исполнитель');
  if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Документы запрашиваются, пока дело в работе');
}

async function requestOf(sql, order, raw) {
  const id = String(raw ?? '');
  const r = /^\d{1,18}$/.test(id) ? await sql.one`select * from doc_requests where id = ${id} and order_id = ${order.id} and cancelled_at is null` : null;
  if (!r) throw new HttpError(404, 'not_found', 'Запрос документа не найден');
  return r;
}

async function view(sql, actor, order, registry) {
  const catalog = registry.requestDocs(order.module, order.service, order.basis_kind);
  const hints = new Map(catalog.map((c) => [c.id, c.hint]));
  const rows = await sql`
    select r.*, d.filename from doc_requests r left join documents d on d.id = r.document_id and d.deleted_at is null
    where r.order_id = ${order.id} and r.cancelled_at is null order by r.id`;
  const requests = rows.map((r) => ({
    id: String(r.id), item_id: r.item_id, title: r.title, hint: (r.item_id && hints.get(r.item_id)) || null, note: r.note,
    requested_at: r.requested_at, done: !!(r.document_id && r.filename),
    document: r.document_id && r.filename ? { id: r.document_id, filename: r.filename } : null,
  }));
  const canRequest = isExecutor(actor, order) && order.status === 'in_work';
  const open = new Set(requests.filter((r) => !r.done && r.item_id).map((r) => r.item_id));
  return {
    requests,
    can_request: canRequest,
    can_upload: orderLevel(actor, order) >= LEVEL.write && !FINAL.includes(order.status),
    // Список услуги — исполнителю: уже запрошенные и ещё не полученные отмечены.
    catalog: canRequest ? catalog.map((c) => ({ ...c, open: open.has(c.id) })) : [],
  };
}

export function docRequestOps() {
  return [
    {
      id: 'doc_requests.list', method: 'GET', path: '/api/orders/:id/doc-requests', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) { return view(sql, actor, order, registry); },
    },
    {
      // Запросить документы: отмеченные из списка услуги и (или) свои строки; уже запрошенные и не полученные — не дублируются.
      id: 'doc_requests.create', method: 'POST', path: '/api/orders/:id/doc-requests', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, body, res }) {
        executorOnly(actor, order);
        const catalog = registry.requestDocs(order.module, order.service, order.basis_kind);
        const ids = Array.isArray(body?.items) ? [...new Set(body.items.map(String))] : [];
        const custom = Array.isArray(body?.custom) ? body.custom.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
        if (custom.length > MAX_CUSTOM) throw new HttpError(400, 'bad_input', `Своими словами — не больше ${MAX_CUSTOM} документов за раз`);
        const items = ids.map((id) => {
          const c = catalog.find((x) => x.id === id);
          if (!c) throw new HttpError(400, 'bad_input', 'Такого документа нет в списке услуги');
          return { item_id: c.id, title: c.title };
        });
        for (const t of custom) items.push({ item_id: null, title: text(t, 'Какой документ нужен', 200) });
        if (!items.length) throw new HttpError(400, 'nothing_selected', 'Отметьте документы или напишите, какой нужен');
        const note = body?.note && String(body.note).trim() ? text(body.note, 'Пояснение для заказчика', 1000) : null;
        const made = await sql.tx(async (tx) => {
          const open = await tx`select item_id, title from doc_requests
                                where order_id = ${order.id} and cancelled_at is null and fulfilled_at is null`;
          if (open.length + items.length > MAX_OPEN) throw new HttpError(409, 'too_many', `Не больше ${MAX_OPEN} неполученных документов в деле`);
          const fresh = items.filter((i) => !open.some((o) => (i.item_id ? o.item_id === i.item_id : o.title === i.title)));
          if (!fresh.length) throw new HttpError(409, 'already_requested', 'Эти документы уже запрошены и ждут заказчика');
          for (const i of fresh) {
            await tx`insert into doc_requests (order_id, item_id, title, note, requested_by)
                     values (${order.id}, ${i.item_id}, ${i.title}, ${note}, ${actor.id})`;
          }
          await audit(tx, actor, 'doc_request.create', 'order', order.id, { titles: fresh.map((i) => i.title) });
          await notify(tx, 'docs_requested', { users: await customersOf(tx, order), orderId: order.id, actor });
          return fresh.length;
        });
        res.status(201);
        return { requested: made, ...(await view(sql, actor, order, registry)) };
      },
    },
    {
      // Заказчик загрузил файл (обычной или прямой загрузкой) — приложить его к запрошенному документу.
      id: 'doc_requests.attach', method: 'POST', path: '/api/orders/:id/doc-requests/:rid/attach', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler({ sql, actor, order, registry, body, params }) {
        if (FINAL.includes(order.status)) throw new HttpError(409, 'order_final', 'Заявка завершена — файлы не добавляются');
        const r = await requestOf(sql, order, params.rid);
        const docId = uuidFrom(body?.document_id, 'Файл не найден');
        const doc = await sql.one`select id, filename from documents
                                  where id = ${docId} and order_id = ${order.id} and deleted_at is null and kind in ('basis', 'other')`;
        if (!doc) throw new HttpError(404, 'not_found', 'Файл не найден');
        await sql.tx(async (tx) => {
          await tx`update doc_requests set document_id = ${doc.id}, fulfilled_at = now() where id = ${r.id}`;
          await audit(tx, actor, 'doc_request.attach', 'order', order.id, { title: r.title });
          if (order.executor_user_id) await notify(tx, 'docs_received', { users: [order.executor_user_id], orderId: order.id, actor });
        });
        return view(sql, actor, order, registry);
      },
    },
    {
      // Исполнитель снимает просьбу (документ больше не нужен) — пока она не выполнена.
      id: 'doc_requests.cancel', method: 'DELETE', path: '/api/orders/:id/doc-requests/:rid', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, params }) {
        executorOnly(actor, order);
        const r = await requestOf(sql, order, params.rid);
        if (r.fulfilled_at) throw new HttpError(409, 'already_done', 'Документ уже получен');
        await sql.tx(async (tx) => {
          await tx`update doc_requests set cancelled_at = now() where id = ${r.id}`;
          await audit(tx, actor, 'doc_request.cancel', 'order', order.id, { title: r.title });
        });
        return view(sql, actor, order, registry);
      },
    },
  ];
}
