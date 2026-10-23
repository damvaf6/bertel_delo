// Запрос недостающих документов (задача 2.64). Исполнитель одной кнопкой просит у заказчика документы из списка услуги
// (описание модуля, request_docs: выписка ЕГРН, ПТС, чек…) или своими словами; заказчику — уведомление (и письмо, если
// заявка пришла по письму). Заказчик видит список с отметками и загружает файл к каждому — исполнителю уведомление.
// Видят запрос все, кто видит заявку; просит и снимает просьбу только исполнитель, пока дело в работе; файл прикладывает
// заказчик (тот, кто может добавлять документы заявки). Удалённый заказчиком файл — просьба снова открыта (core-ops.mjs).
// Выписка ЕГРН в деле старше 30 дней на дату оценки (2.224) — исполнителю подсказка запросить свежую одной кнопкой.
// Запрошенное не пришло 3 дня (2.234) — «Напомнить заказчику» одной кнопкой, не чаще раза в сутки; строка и в «Сегодня».
// Оценка для банка, задания на оценку нет и его не запрашивали, а до срока дела 3 дня или меньше (2.306) — строка в «Сегодня».
import { HttpError } from '../http/core.mjs';
import { FINAL, addDays, todayMsk } from '../orders/workflow.mjs';
import { assignmentValue, egrnIssued, egrnOnObject } from '../ai/report-checks.mjs';
import { assignmentDocs, egrnDocs, TASK_ITEMS, TASK_MOVE } from './ai-ops.mjs';
import { taskMoved } from './deadline-ops.mjs';
import { LEVEL, orderLevel, orderSides } from '../access/policy.mjs';
import { customersOf, notify } from '../notify/notify.mjs';
import { audit, text, uuidFrom } from './util.mjs';
import { workingMs } from '../orders/silence.mjs';

const MAX_CUSTOM = 5;
const MAX_OPEN = 30;

// Выписка ЕГРН «не старше месяца» (подсказка в request_docs модуля): старше — подсказать запросить свежую.
export const EGRN_FRESH_DAYS = 30;
// Запрошенный документ не пришёл столько дней — исполнителю «Напомнить заказчику» (2.234); снова — через сутки.
export const DOC_WAIT_DAYS = 3;
export const DOC_REMIND_EVERY_HOURS = 24;
// До срока дела столько дней или меньше, а задания на оценку от банка нет и не просили (2.306).
export const BANK_TASK_DAYS = 3;

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

// 2.224: самая свежая выписка ЕГРН дела старше 30 дней на дату оценки (из задания на оценку, письма или определения суда —
// 2.207; без неё — на сегодня). Только для услуг, где выписку можно запросить (request_docs: egrn), и пока дело в работе.
// { id, name, page, day, on, on_value, age, asked } — asked: свежая выписка уже запрошена и ещё не получена; иначе null.
export async function egrnOld(sql, storage, registry, order, today = todayMsk()) {
  if (order.status !== 'in_work' || !storage) return null;
  if (!registry.requestDocs(order.module, order.service, order.basis_kind, order.fields).some((c) => c.id === 'egrn')) return null;
  // Выписка на дом при оценке квартиры (и наоборот) свежесть не решает (2.230).
  const docs = egrnOnObject(await egrnDocs(sql, storage, order), order);
  const issued = egrnIssued(docs);
  // Последняя загруженная выписка без распознанной даты (заказчик прислал свежую не тем видом) — не судим.
  if (!issued.length || !issued.some((x) => x.id === docs[0].id)) return null;
  const last = issued.reduce((a, b) => (b.day > a.day ? b : a));
  const value = assignmentValue(await assignmentDocs(sql, storage, order)).day ?? null;
  const on = value ?? today;
  const age = Math.round((Date.parse(`${on}T00:00:00Z`) - Date.parse(`${last.day}T00:00:00Z`)) / 86400_000);
  if (age <= EGRN_FRESH_DAYS) return null;
  const asked = !!(await sql`select 1 from doc_requests where order_id = ${order.id} and item_id = 'egrn'
                             and cancelled_at is null and fulfilled_at is null limit 1`).length;
  return { id: last.id, name: last.name, page: last.page, day: last.day, on, on_value: !!value, age, asked };
}

// 2.234: какие запрошенные документы ждут заказчика 3 дня и дольше (пока дело в работе), когда напоминали и можно ли снова.
// 2.381: 3 дня — рабочих, по Москве (как «Заказчик не отвечает», прогон 2.380): в выходные и праздники заказчик не работает.
// `days` — сколько дней ждём по календарю (так и показываем). { titles, since, days, reminded_at, reminders, can_remind,
// next_remind_at } или null.
export const docLong = (at, now = new Date()) => workingMs(at, now) >= DOC_WAIT_DAYS * 86400_000;
export async function docWait(sql, order, now = new Date()) {
  if (order.status !== 'in_work') return null;
  const rows = (await sql`select item_id, title, requested_at from doc_requests
                          where order_id = ${order.id} and cancelled_at is null and fulfilled_at is null
                            and requested_at <= ${new Date(now.getTime() - DOC_WAIT_DAYS * 86400_000)} order by requested_at, id`)
    .filter((r) => docLong(r.requested_at, now));
  if (!rows.length) return null;
  const since = rows[0].requested_at;
  // Напоминания — только с тех пор, как ждём самый старый из неполученных: прежние по уже пришедшим не в счёт.
  const last = await sql.one`select max(created_at) as at, count(*)::int as n from doc_reminders
                             where order_id = ${order.id} and created_at >= ${since}`;
  const next = last?.at ? new Date(new Date(last.at).getTime() + DOC_REMIND_EVERY_HOURS * 3600_000) : null;
  return {
    titles: rows.map((r) => r.title),
    // 2.347: только письмо о переносе — в «Сегодня» напоминание у строки письма, а не отдельной строкой.
    only_letter: rows.every((r) => r.item_id === TASK_MOVE),
    since,
    days: Math.floor((now.getTime() - new Date(since).getTime()) / 86400_000),
    reminded_at: last?.at ?? null,
    reminders: last?.n ?? 0,
    can_remind: !next || next <= now,
    next_remind_at: next && next > now ? next : null,
  };
}

// 2.306: оценка для банка (в списке услуги есть «Задание на оценку от банка» — 2.299), дело в работе, до срока
// 3 дня или меньше (или прошёл), задания в деле нет и его не запрашивали (снятая просьба — не в счёт).
// { item_id, title, days } — days: сколько дней до срока (меньше нуля — просрочено); иначе null.
export async function bankTaskMissing(sql, storage, registry, order, today = todayMsk()) {
  if (order.status !== 'in_work' || !storage || !order.deadline || order.deadline > addDays(today, BANK_TASK_DAYS)) return null;
  const item = registry.requestDocs(order.module, order.service, order.basis_kind, order.fields).find((c) => TASK_ITEMS.includes(c.id));
  if (!item) return null;
  const asked = await sql`select 1 from doc_requests where order_id = ${order.id} and item_id = any(${TASK_ITEMS}::text[])
                          and cancelled_at is null limit 1`;
  if (asked.length || (await assignmentDocs(sql, storage, order)).length) return null;
  const days = Math.round((Date.parse(`${order.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
  return { item_id: item.id, title: item.title, days };
}

// Ждём документы от заказчика (2.235) — руководителю в «Делах экспертов»: по делам в работе неполученные запросы с любого
// дня (что ждём, с какого дня самый старый, когда эксперт напоминал); `long` — ждём ${DOC_WAIT_DAYS} рабочих дня и дольше (2.381).
export async function docsWaiting(sql, orders, now = new Date()) {
  const ids = orders.filter((o) => o.status === 'in_work').map((o) => o.id);
  if (!ids.length) return new Map();
  const rows = await sql`
    select r.order_id, array_agg(r.title order by r.requested_at, r.id) as titles, min(r.requested_at) as since,
           (select max(m.created_at) from doc_reminders m where m.order_id = r.order_id and m.created_at >= min(r.requested_at)) as reminded_at
    from doc_requests r where r.order_id = any(${ids}::uuid[]) and r.cancelled_at is null and r.fulfilled_at is null
    group by r.order_id`;
  return new Map(rows.map((r) => {
    const days = Math.max(0, Math.floor((now.getTime() - new Date(r.since).getTime()) / 86400_000));
    return [r.order_id, { titles: r.titles, since: r.since, days, long: docLong(r.since, now), reminded_at: r.reminded_at ?? null }];
  }));
}

// Пояснение заказчику к просьбе о свежей выписке — сразу видно, почему старая не годится.
export const egrnOldNote = (o) => `Выписка ЕГРН в деле от ${o.day.split('-').reverse().join('.')} — старше ${EGRN_FRESH_DAYS} дней на ${o.on_value ? 'дату оценки' : 'сегодня'}. Нужна свежая выписка: закажите её на Госуслугах или в МФЦ и загрузите сюда.`;

const ruDay = (iso) => iso.split('-').reverse().join('.');

async function view(sql, actor, order, registry, storage) {
  const catalog = registry.requestDocs(order.module, order.service, order.basis_kind, order.fields);
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
  // Документ основания (определение суда) заказчик уже приложил к заявке — просить его снова незачем (2.79).
  const basisAttached = canRequest && catalog.some((c) => c.basis)
    && !!(await sql`select 1 from documents where order_id = ${order.id} and kind = 'basis' and deleted_at is null limit 1`).length;
  // Задание банка уже в деле (основание, письмо, приложено к просьбе) — просить его снова незачем (2.299).
  const taskAttached = canRequest && catalog.some((c) => TASK_ITEMS.includes(c.id))
    && (await assignmentDocs(sql, storage, order)).length > 0;
  const open = new Set(requests.filter((r) => !r.done && r.item_id).map((r) => r.item_id));
  return {
    requests,
    can_request: canRequest,
    can_upload: orderLevel(actor, order) >= LEVEL.write && !FINAL.includes(order.status),
    // Список услуги — исполнителю: уже запрошенные и ещё не полученные отмечены.
    catalog: canRequest ? catalog.filter((c) => !(c.basis && basisAttached) && !(taskAttached && TASK_ITEMS.includes(c.id) && !open.has(c.id))).map(({ basis, ...c }) => ({ ...c, open: open.has(c.id) })) : [],
    // Выписка ЕГРН старше 30 дней на дату оценки (2.224) — исполнителю.
    egrn_old: canRequest ? await egrnOld(sql, storage, registry, order) : null,
    // Не пришло 3 дня и дольше (2.234) — исполнителю «Напомнить заказчику».
    wait: canRequest ? await docWait(sql, order) : null,
  };
}

export function docRequestOps() {
  return [
    {
      id: 'doc_requests.list', method: 'GET', path: '/api/orders/:id/doc-requests', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers }) { return view(sql, actor, order, registry, providers.storage); },
    },
    {
      // Запросить документы: отмеченные из списка услуги и (или) свои строки; уже запрошенные и не полученные — не дублируются.
      id: 'doc_requests.create', method: 'POST', path: '/api/orders/:id/doc-requests', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, body, res }) {
        executorOnly(actor, order);
        const catalog = registry.requestDocs(order.module, order.service, order.basis_kind, order.fields);
        const ids = Array.isArray(body?.items) ? [...new Set(body.items.map(String))] : [];
        const custom = Array.isArray(body?.custom) ? body.custom.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
        if (custom.length > MAX_CUSTOM) throw new HttpError(400, 'bad_input', `Своими словами — не больше ${MAX_CUSTOM} документов за раз`);
        const items = ids.map((id) => {
          const c = catalog.find((x) => x.id === id);
          if (!c) throw new HttpError(400, 'bad_input', 'Такого документа нет в списке услуги');
          return { item_id: c.id, title: c.title };
        });
        for (const t of custom) items.push({ item_id: null, title: text(t, 'Какой документ нужен', 200) });
        // «Попросить письмо о переносе» (2.326): перенос согласован, а срок по заданию на оценку раньше нового срока.
        let moveNote = null;
        if (body?.task_move) {
          const m = await taskMoved(sql, providers.storage, registry, order);
          if (!m) throw new HttpError(409, 'no_task_move', 'Срок дела не позже срока по заданию на оценку — письмо о переносе не нужно');
          items.push({ item_id: TASK_MOVE, title: `${m.doc} о переносе срока отчёта на ${ruDay(m.deadline)}` });
          moveNote = `${m.letter ? `В приложенном документе срок — ${ruDay(m.day)}, а нужен новый. ` : ''}Срок отчёта перенесён на ${ruDay(m.deadline)}, а ${m.by} отчёт ждут к ${ruDay(m.day)}. `
            + `${m.who === 'Суд' ? 'Нужно определение суда о продлении срока' : m.who === 'Банк' ? 'Попросите банк подтвердить новый срок письмом' : 'Подтвердите новый срок письмом'} — и загрузите сюда.`;
        }
        if (!items.length) throw new HttpError(400, 'nothing_selected', 'Отметьте документы или напишите, какой нужен');
        let note = body?.note && String(body.note).trim() ? text(body.note, 'Пояснение для заказчика', 1000) : moveNote;
        // «Запросить свежую выписку» (2.224): пояснение заказчику — от какого числа выписка в деле и почему нужна новая.
        if (body?.fresh_egrn && !note && ids.includes('egrn')) {
          const old = await egrnOld(sql, providers.storage, registry, order);
          if (old) note = egrnOldNote(old);
        }
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
        return { requested: made, ...(await view(sql, actor, order, registry, providers.storage)) };
      },
    },
    {
      // Заказчик загрузил файл (обычной или прямой загрузкой) — приложить его к запрошенному документу.
      id: 'doc_requests.attach', method: 'POST', path: '/api/orders/:id/doc-requests/:rid/attach', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler({ sql, actor, order, registry, providers, body, params }) {
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
        return view(sql, actor, order, registry, providers.storage);
      },
    },
    {
      // «Напомнить заказчику» (2.234): запрошенное не пришло 3 дня — уведомление (и письмо) заказчику, раз в сутки по делу.
      id: 'doc_requests.remind', method: 'POST', path: '/api/orders/:id/doc-requests/remind', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, res }) {
        executorOnly(actor, order);
        await sql.tx(async (tx) => {
          // Два нажатия одновременно — одно напоминание: блокируем строку заявки до записи.
          await tx`select id from orders where id = ${order.id} for update`;
          const w = await docWait(tx, order);
          if (!w) throw new HttpError(409, 'not_waiting', `Напомнить можно, когда запрошенный документ не пришёл ${DOC_WAIT_DAYS} рабочих дня`);
          if (!w.can_remind) throw new HttpError(409, 'too_often', 'Напомнить можно раз в сутки — заказчик уже получил напоминание');
          const users = await customersOf(tx, order);
          if (!users.length) throw new HttpError(409, 'no_customer', 'У заявки нет заказчика в кабинете — напомнить некому');
          await tx`insert into doc_reminders (order_id, user_id, titles) values (${order.id}, ${actor.id}, ${w.titles})`;
          await notify(tx, 'docs_reminder', { users, orderId: order.id, actor });
          await audit(tx, actor, 'doc_request.remind', 'order', order.id, { titles: w.titles });
        });
        res.status(201);
        return view(sql, actor, order, registry, providers.storage);
      },
    },
    {
      // Исполнитель снимает просьбу (документ больше не нужен) — пока она не выполнена.
      id: 'doc_requests.cancel', method: 'DELETE', path: '/api/orders/:id/doc-requests/:rid', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, params }) {
        executorOnly(actor, order);
        const r = await requestOf(sql, order, params.rid);
        if (r.fulfilled_at) throw new HttpError(409, 'already_done', 'Документ уже получен');
        await sql.tx(async (tx) => {
          await tx`update doc_requests set cancelled_at = now() where id = ${r.id}`;
          await audit(tx, actor, 'doc_request.cancel', 'order', order.id, { title: r.title });
        });
        return view(sql, actor, order, registry, providers.storage);
      },
    },
  ];
}
