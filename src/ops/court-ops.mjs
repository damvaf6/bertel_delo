// Вызов эксперта в суд (задача 2.441). После «готово» заказчик или диспетчер пишет, что эксперта вызывают на заседание:
// суд, номер дела, дата и время, адрес и файл повестки или определения. Дело не переоткрывается (статус прежний), эксперту —
// уведомление. Вызовов может быть несколько (заседание отложили — новый вызов). Видят все, кто видит дело.
// 2.444: «Пояснения к отчёту для суда» — у вызова вопросы суда к эксперту: ИИ делит текст определения или повестки на
// пункты (как замечания, 2.432), эксперт правит вопросы, пишет пояснение и где в отчёте; ответил на все — Word
// «Пояснения эксперта к отчёту». Пишет только эксперт дела, видят все стороны.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { askAi, parseJsonAnswer } from '../ai/ai.mjs';
import { READ_MAX_BYTES, extractPages, readableKind } from '../ai/extract.mjs';
import { ANSWER_MAX, ITEMS_MAX, ITEM_MAX, PLACE_MAX, SOURCE_MAX, cleanItems, courtMessages, splitRemarks } from '../orders/court.mjs';
import { courtExplainData, courtExplainDoc } from '../docs/court-explain.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { notify } from '../notify/notify.mjs';
import { todayMsk, addDays } from '../orders/workflow.mjs';
import { workdaysAfter } from '../orders/holidays.mjs';
import { hearingsOf } from '../orders/schedule.mjs';
import { BLOCKING_KINDS, KINDS, loadDossier } from '../dossier/dossier.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit, sendFile, text, uuidFrom } from './util.mjs';

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
    select c.id, c.court, c.case_no, c.hearing_at, c.address, c.side, c.created_at, d.id as doc_id, d.filename,
           (select count(*)::int from court_questions q where q.call_id = c.id) as questions,
           (select count(*)::int from court_questions q where q.call_id = c.id and q.answer is null) as unanswered
    from court_calls c left join documents d on d.id = c.document_id and d.deleted_at is null
    where c.order_id = ${order.id} order by c.hearing_at, c.id`;
  return rows.map((r) => ({
    id: String(r.id), court: r.court, case_no: r.case_no, hearing_at: r.hearing_at, address: r.address, side: r.side,
    created_at: r.created_at, document: r.doc_id ? { id: r.doc_id, filename: r.filename } : null,
    questions: r.questions, unanswered: r.unanswered,
  }));
}

// Пояснения к отчёту для суда (2.444) ведёт эксперт дела, пока дело сдано (готово или закрыто).
const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
const canAnswer = (registry, actor, order) => registry.court(order.module) && AFTER.includes(order.status) && isExecutor(actor, order);

async function view(sql, registry, actor, order) {
  if (!registry.court(order.module)) return { available: false };
  const list = await calls(sql, order);
  const now = Date.now();
  return { available: true, can_add: canCall(registry, actor, order), can_answer: canAnswer(registry, actor, order), calls: list,
           next: list.find((c) => new Date(c.hearing_at).getTime() >= now - 3 * 3600 * 1000)?.id ?? null };
}

// ——— Пояснения к отчёту для суда (2.444) ———
// Вызов этого дела по номеру из адреса; чужой или несуществующий — «не найдено».
async function callOf(sql, registry, order, raw) {
  if (!registry.court(order.module)) throw new HttpError(409, 'not_supported', 'Вызов в суд — только для экспертизы');
  const id = /^\d{1,15}$/.test(String(raw ?? '')) ? String(raw) : null;
  const c = id ? await sql.one`select * from court_calls where id = ${id} and order_id = ${order.id}` : null;
  if (!c) throw new HttpError(404, 'not_found', 'Вызов в суд не найден в этом деле');
  return c;
}

async function questions(sql, call) {
  const rows = await sql`select id, body, answer, place, by_ai from court_questions where call_id = ${call.id} order by pos, id`;
  return rows.map((r) => ({ id: String(r.id), text: r.body, answer: r.answer ?? '', place: r.place ?? '', by_ai: r.by_ai }));
}

async function questionsView(sql, registry, actor, order, call) {
  const list = await questions(sql, call);
  const left = list.filter((q) => !q.answer).length;
  return { call_id: String(call.id), can_write: canAnswer(registry, actor, order), has_file: !!call.document_id,
           items: list, left, ready: list.length > 0 && !left };
}

function answerable(registry, actor, order) {
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Пояснения для суда пишет эксперт дела');
  if (!AFTER.includes(order.status)) throw new HttpError(409, 'status_changed', 'Пояснения для суда — после того, как отчёт сдан');
}

// Текст для разбора: что вписал эксперт и прочитанный файл повестки или определения.
async function courtSource(sql, storage, call, said) {
  let file = '';
  let unread = false;
  if (call.document_id) {
    const d = await sql.one`select * from documents where id = ${call.document_id} and deleted_at is null`;
    if (d) {
      const buf = readableKind(d.filename, d.mime) && d.size_bytes <= READ_MAX_BYTES ? await storage.get(d.storage_key) : null;
      const got = buf ? await extractPages(buf, d.filename, d.mime) : null;
      if (got) file = got.pages.join('\n\n').slice(0, SOURCE_MAX);
      else unread = true;
    }
  }
  return { text: said, file, unread };
}

async function replaceQuestions(tx, actor, call, list, byAi) {
  await tx`delete from court_questions where call_id = ${call.id}`;
  for (const [pos, q] of list.entries()) {
    await tx`insert into court_questions (call_id, pos, body, answer, place, by_ai, updated_by)
             values (${call.id}, ${pos}, ${q.text}, ${q.answer || null}, ${q.place || null}, ${q.by_ai ?? byAi}, ${actor.id})`;
  }
}

// Вопросы из запроса эксперта: текст обязателен, пояснение и место в отчёте — по желанию (без пояснения — Word не собрать).
function questionsFrom(body) {
  const raw = body?.items;
  if (!Array.isArray(raw)) throw new HttpError(400, 'bad_input', 'Нужен список вопросов');
  if (raw.length > ITEMS_MAX) throw new HttpError(400, 'bad_input', `Вопросов — не больше ${ITEMS_MAX}`);
  return raw.map((q, i) => {
    const t = String(q?.text ?? '').trim();
    if (!t || t.length > ITEM_MAX) throw new HttpError(400, 'bad_input', `Вопрос ${i + 1}: текст от 1 до ${ITEM_MAX} символов`);
    const answer = String(q?.answer ?? '').trim();
    if (answer.length > ANSWER_MAX) throw new HttpError(400, 'bad_input', `Вопрос ${i + 1}: пояснение — не больше ${ANSWER_MAX} символов`);
    const place = String(q?.place ?? '').trim();
    if (place.length > PLACE_MAX) throw new HttpError(400, 'bad_input', `Вопрос ${i + 1}: место в отчёте — не больше ${PLACE_MAX} символов`);
    return { text: t, answer, place, by_ai: q?.by_ai === true };
  });
}

// Заседание сегодня или завтра (2.443) — в «Сегодня» эксперта: что взять с собой. В пятницу «завтра» — и понедельник
// (следующий рабочий день). Прошедшее больше трёх часов назад — уже нет. Отчёт — последний свой файл результата дела (после
// замечаний — новая редакция), ответ на замечания, если приложен, повестка; аттестат и полисы — из досье: срок кончился до
// дня заседания — предупреждение, нет в досье — тоже. Полис организации — только если он есть в досье.
const MUST = ['certificate', 'policy'];
export async function hearingsSoon(sql, userId, today = todayMsk(), now = new Date()) {
  const last = [addDays(today, 1), workdaysAfter(today, 1)].sort().at(-1);
  const list = (await hearingsOf(sql, userId, today, last)).filter((h) => new Date(h.hearing_at).getTime() >= now.getTime() - 3 * 3600 * 1000);
  if (!list.length) return [];
  const dossier = (await loadDossier(sql, userId)).filter((i) => BLOCKING_KINDS.includes(i.kind));
  const out = [];
  for (const h of list) {
    const day = todayMsk(new Date(h.hearing_at));
    const o = await sql.one`select id, report_number, remarks_at, remarks_answer_doc_id from orders where id = ${h.order_id}`;
    const report = await sql.one`
      select id, filename, created_at from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null
        and uploaded_by = ${userId} and id is distinct from ${o.remarks_answer_doc_id} order by created_at desc, id desc limit 1`;
    const answer = o.remarks_answer_doc_id ? await sql.one`select id, filename from documents where id = ${o.remarks_answer_doc_id} and deleted_at is null` : null;
    const summons = await sql.one`select d.id, d.filename from court_calls c join documents d on d.id = c.document_id and d.deleted_at is null where c.id = ${h.id}`;
    const docs = dossier.map((i) => ({ kind: i.kind, kind_name: i.kind_name, number: i.number, valid_until: i.valid_until,
      expired: !!i.valid_until && i.valid_until < day }));
    out.push({
      id: h.order_id, title: h.title, call_id: String(h.id), court: h.court, case_no: h.case_no, address: h.address,
      hearing_at: h.hearing_at, day, today: day === today,
      time: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(h.hearing_at)),
      report: report ? { id: report.id, filename: report.filename, number: o.report_number ?? null,
        edition: !!o.remarks_at && new Date(report.created_at) >= new Date(o.remarks_at) } : null,
      answer: answer ? { id: answer.id, filename: answer.filename } : null,
      summons: summons ? { id: summons.id, filename: summons.filename } : null,
      dossier: docs,
      missing: MUST.filter((k) => !docs.some((d) => d.kind === k)).map((k) => KINDS[k].name),
    });
  }
  return out;
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
    {
      id: 'court.questions', method: 'GET', path: '/api/orders/:id/court/:call/questions', auth: 'user', access,
      async handler({ sql, registry, actor, order, params }) {
        return questionsView(sql, registry, actor, order, await callOf(sql, registry, order, params.call));
      },
    },
    {
      // ИИ делит вопросы суда на пункты: из вписанного экспертом текста и файла повестки. Вопросы уже есть — только с
      // replace: true (эксперт подтвердил «Заменить»).
      id: 'court.questions.parse', method: 'POST', path: '/api/orders/:id/court/:call/questions/parse', auth: 'user', access,
      async handler(ctx) {
        const { sql, registry, actor, order, body, params, providers } = ctx;
        const call = await callOf(sql, registry, order, params.call);
        answerable(registry, actor, order);
        if (body?.replace !== true && (await questions(sql, call)).length) {
          throw new HttpError(409, 'items_exist', 'Вопросы уже есть — заменить их новым разбором?');
        }
        const said = String(body?.text ?? '').trim().slice(0, SOURCE_MAX);
        const src = await courtSource(sql, providers.storage, call, said);
        if (!src.text && !src.file) {
          throw new HttpError(409, 'nothing_to_parse', src.unread
            ? 'Файл повестки прочитать не удалось — впишите вопросы суда текстом или добавьте их сами'
            : 'Впишите вопросы суда текстом или добавьте их сами — файла повестки с вопросами нет');
        }
        const out = await askAi(ctx, actor, 'court', courtMessages(src));
        let list = cleanItems(parseJsonAnswer(out.text)?.items);
        if (!list.length) list = splitRemarks([src.text, src.file].filter(Boolean).join('\n\n'));
        if (!list.length) throw new HttpError(409, 'nothing_to_parse', 'Вопросов в тексте не нашлось — добавьте их сами');
        await sql.tx(async (tx) => {
          await replaceQuestions(tx, actor, call, list.map((t) => ({ text: t })), true);
          await audit(tx, actor, 'court.questions.parse', 'order', order.id, { call: String(call.id), items: list.length, model: out.model });
        });
        return { ...(await questionsView(sql, registry, actor, order, call)), file_unread: src.unread };
      },
    },
    {
      id: 'court.questions.save', method: 'PUT', path: '/api/orders/:id/court/:call/questions', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, params }) {
        const call = await callOf(sql, registry, order, params.call);
        answerable(registry, actor, order);
        const list = questionsFrom(body);
        await sql.tx(async (tx) => {
          await replaceQuestions(tx, actor, call, list, false);
          await audit(tx, actor, 'court.questions.save', 'order', order.id, { call: String(call.id), items: list.length });
        });
        return questionsView(sql, registry, actor, order, call);
      },
    },
    {
      // Word «Пояснения эксперта к отчёту» — видят все стороны дела, когда у каждого вопроса есть пояснение.
      id: 'court.explain', method: 'GET', path: '/api/orders/:id/court/:call/explain', auth: 'user', access,
      async handler({ sql, registry, actor, order, params, providers, res }) {
        const call = await callOf(sql, registry, order, params.call);
        const list = await questions(sql, call);
        if (!list.length) throw new HttpError(409, 'no_items', 'Вопросов суда ещё нет — сначала разберите их');
        const left = list.findIndex((q) => !q.answer);
        if (left >= 0) throw new HttpError(409, 'items_unanswered', `Вопрос ${left + 1}: напишите пояснение и сохраните`);
        const [ex] = order.executor_user_id ? await sql`select full_name from users where id = ${order.executor_user_id}` : [];
        const def = registry.service(order.module, order.service);
        const data = courtExplainData({ order, call, service: def?.service.name ?? order.title, executor: ex?.full_name, items: list });
        await audit(sql, actor, 'court.explain', 'order', order.id, { call: String(call.id), items: list.length });
        return sendFile(res, providers, { ...courtExplainDoc(data), mime: DOCX_MIME });
      },
    },
  ];
}
