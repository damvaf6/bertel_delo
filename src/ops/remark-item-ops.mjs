// Замечания к сданному отчёту пунктами (задача 2.432). Пришли замечания (2.431) — эксперт нажимает «Разобрать на пункты»:
// ИИ делит текст заказчика и файл замечаний на отдельные пункты, эксперт правит текст, удаляет и добавляет пункты и у
// каждого отмечает «исправлено в отчёте» или «пояснение без правки» (и что сделано или что пояснить). Пункты — по кругу
// замечаний: пришли замечания снова — новый список. Видят все стороны дела; пишет только исполнитель, пока дело снова у него.
// 2.433: у пункта — где в отчёте (раздел, страница); все пункты отмечены — «Ответ на замечания» Word: скачать или приложить
// к исправленному отчёту файлом результата (подписывается вместе с отчётом).
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { askAi, parseJsonAnswer } from '../ai/ai.mjs';
import { READ_MAX_BYTES, extractPages, readableKind } from '../ai/extract.mjs';
import { ITEMS_MAX, ITEM_MAX, PLACE_MAX, RESOLUTIONS, SOURCE_MAX, cleanItems, remarkMessages, splitRemarks } from '../orders/remarks.mjs';
import { remarksAnswerData, remarksAnswerDoc } from '../docs/remarks-answer.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit, sendFile } from './util.mjs';

const OPEN = ['in_work', 'review'];
const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');

async function items(sql, order) {
  const rows = await sql`select id, pos, body, resolution, note, place, by_ai, updated_at from remark_items
                         where order_id = ${order.id} and round = ${order.remarks_round} order by pos, id`;
  return rows.map((r) => ({ id: String(r.id), text: r.body, resolution: r.resolution, note: r.note ?? '', place: r.place ?? '', by_ai: r.by_ai }));
}

async function view(sql, actor, order) {
  if (!order.remarks_at) return { available: false };
  const list = await items(sql, order);
  const answer = await answerDoc(sql, order);
  return { available: true, round: order.remarks_round, can_write: isExecutor(actor, order) && OPEN.includes(order.status),
           items: list, left: list.filter((i) => !i.resolution).length,
           answer: answer ? { id: answer.id, filename: answer.filename, created_at: answer.created_at } : null };
}

// Ответ на замечания, приложенный в этом круге (после прихода замечаний) и не удалённый.
async function answerDoc(sql, order) {
  if (!order.remarks_answer_doc_id) return null;
  return sql.one`select id, filename, created_at from documents where id = ${order.remarks_answer_doc_id} and deleted_at is null
                 and created_at >= ${order.remarks_at}`;
}

// Сведения для Word: пункты есть и у каждого отметка.
async function answerData(sql, registry, order) {
  const list = await items(sql, order);
  if (!list.length) throw new HttpError(409, 'no_items', 'Пунктов замечаний ещё нет — сначала разберите замечания на пункты');
  const left = list.findIndex((i) => !i.resolution);
  if (left >= 0) throw new HttpError(409, 'items_unmarked', `Пункт ${left + 1}: отметьте «исправлено в отчёте» или «пояснение без правки» и сохраните`);
  const [ex] = order.executor_user_id ? await sql`select full_name from users where id = ${order.executor_user_id}` : [];
  const def = registry.service(order.module, order.service);
  return remarksAnswerData({ order, service: def?.service.name ?? order.title, executor: ex?.full_name, items: list });
}

function writable(actor, order) {
  if (!order.remarks_at) throw new HttpError(409, 'no_remarks', 'Замечаний к отчёту по делу не было');
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Пункты замечаний ведёт исполнитель дела');
  if (!OPEN.includes(order.status)) throw new HttpError(409, 'status_changed', 'Дело уже сдано — пункты только для чтения');
}

// Текст замечаний этого круга: что написал заказчик (история статусов) и прочитанный файл замечаний.
async function remarkSource(sql, storage, order) {
  const h = await sql.one`select reason from order_status_history where order_id = ${order.id} and from_status = 'done'
                          and to_status = 'in_work' order by id desc limit 1`;
  let file = '';
  let unread = false;
  if (order.remarks_doc_id) {
    const d = await sql.one`select * from documents where id = ${order.remarks_doc_id} and deleted_at is null`;
    if (d) {
      const buf = readableKind(d.filename, d.mime) && d.size_bytes <= READ_MAX_BYTES ? await storage.get(d.storage_key) : null;
      const got = buf ? await extractPages(buf, d.filename, d.mime) : null;
      if (got) file = got.pages.join('\n\n').slice(0, SOURCE_MAX);
      else unread = true;
    }
  }
  return { text: h?.reason ?? '', file, unread };
}

async function replace(tx, actor, order, list, byAi) {
  await tx`delete from remark_items where order_id = ${order.id} and round = ${order.remarks_round}`;
  for (const [pos, it] of list.entries()) {
    await tx`insert into remark_items (order_id, round, pos, body, resolution, note, place, by_ai, updated_by)
             values (${order.id}, ${order.remarks_round}, ${pos}, ${it.text}, ${it.resolution ?? null}, ${it.note || null},
                     ${it.place || null}, ${it.by_ai ?? byAi}, ${actor.id})`;
  }
}

// Пункты из запроса эксперта: текст обязателен, отметка — одна из двух или пусто, пояснение и место в отчёте — по желанию.
function itemsFrom(body) {
  const raw = body?.items;
  if (!Array.isArray(raw)) throw new HttpError(400, 'bad_input', 'Нужен список пунктов');
  if (raw.length > ITEMS_MAX) throw new HttpError(400, 'bad_input', `Пунктов — не больше ${ITEMS_MAX}`);
  return raw.map((it, i) => {
    const text = String(it?.text ?? '').trim();
    if (!text || text.length > ITEM_MAX) throw new HttpError(400, 'bad_input', `Пункт ${i + 1}: текст от 1 до ${ITEM_MAX} символов`);
    const resolution = it?.resolution ?? null;
    if (resolution !== null && !RESOLUTIONS.includes(resolution)) throw new HttpError(400, 'bad_input', `Пункт ${i + 1}: недопустимая отметка`);
    const note = String(it?.note ?? '').trim();
    if (note.length > ITEM_MAX) throw new HttpError(400, 'bad_input', `Пункт ${i + 1}: пояснение — не больше ${ITEM_MAX} символов`);
    const place = String(it?.place ?? '').trim();
    if (place.length > PLACE_MAX) throw new HttpError(400, 'bad_input', `Пункт ${i + 1}: место в отчёте — не больше ${PLACE_MAX} символов`);
    return { text, resolution, note, place, by_ai: it?.by_ai === true };
  });
}

export function remarkItemOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  return [
    {
      id: 'remarks.items', method: 'GET', path: '/api/orders/:id/remarks/items', auth: 'user', access,
      async handler({ sql, actor, order }) { return view(sql, actor, order); },
    },
    {
      // ИИ делит замечания на пункты. Пункты уже есть — только с replace: true (эксперт подтвердил «Заменить»).
      id: 'remarks.items.parse', method: 'POST', path: '/api/orders/:id/remarks/items/parse', auth: 'user', access,
      async handler(ctx) {
        const { sql, actor, order, body, providers } = ctx;
        writable(actor, order);
        if (body?.replace !== true && (await items(sql, order)).length) {
          throw new HttpError(409, 'items_exist', 'Пункты уже есть — заменить их новым разбором?');
        }
        const src = await remarkSource(sql, providers.storage, order);
        if (!src.text.trim() && !src.file) throw new HttpError(409, 'nothing_to_parse', 'Текст замечаний прочитать не удалось — добавьте пункты сами');
        const out = await askAi(ctx, actor, 'remarks', remarkMessages(src));
        let list = cleanItems(parseJsonAnswer(out.text)?.items);
        // Модель ответила не списком — пункты по нумерации текста.
        if (!list.length) list = splitRemarks([src.file, src.text].filter(Boolean).join('\n\n'));
        await sql.tx(async (tx) => {
          await replace(tx, actor, order, list.map((text) => ({ text })), true);
          await audit(tx, actor, 'remarks.items.parse', 'order', order.id, { round: order.remarks_round, items: list.length, model: out.model });
        });
        return { ...(await view(sql, actor, order)), file_unread: src.unread };
      },
    },
    {
      id: 'remarks.items.save', method: 'PUT', path: '/api/orders/:id/remarks/items', auth: 'user', access,
      async handler({ sql, actor, order, body }) {
        writable(actor, order);
        const list = itemsFrom(body);
        await sql.tx(async (tx) => {
          await replace(tx, actor, order, list, false);
          await audit(tx, actor, 'remarks.items.save', 'order', order.id, { round: order.remarks_round, items: list.length });
        });
        return view(sql, actor, order);
      },
    },
    {
      // «Ответ на замечания» Word (2.433) — видят все стороны дела, когда все пункты отмечены.
      id: 'remarks.answer', method: 'GET', path: '/api/orders/:id/remarks/answer', auth: 'user', access,
      async handler({ sql, actor, order, registry, providers, res }) {
        if (!order.remarks_at) throw new HttpError(409, 'no_remarks', 'Замечаний к отчёту по делу не было');
        const data = await answerData(sql, registry, order);
        await audit(sql, actor, 'remarks.answer', 'order', order.id, { round: order.remarks_round, items: data.rows.length });
        return sendFile(res, providers, { ...remarksAnswerDoc(data), mime: DOCX_MIME });
      },
    },
    {
      // Приложить ответ к исправленному отчёту файлом результата. Уже приложен в этом круге — только с replace: true
      // (прежний файл ответа убирается из дела, как при «Удалить» исполнителем).
      id: 'remarks.answer.attach', method: 'POST', path: '/api/orders/:id/remarks/answer', auth: 'user', access,
      async handler(ctx) {
        const { sql, actor, order, registry, body, res } = ctx;
        writable(actor, order);
        if (order.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Приложить ответ можно, пока дело в работе');
        const data = await answerData(sql, registry, order);
        const prev = await answerDoc(sql, order);
        if (prev && body?.replace !== true) throw new HttpError(409, 'answer_exists', `Ответ уже приложен (${prev.filename}) — заменить новым?`);
        const word = remarksAnswerDoc(data);
        const doc = await saveDocument(ctx, { filename: word.filename, mime: DOCX_MIME, buf: word.buf, kind: 'result' });
        await sql.tx(async (tx) => {
          if (prev) await tx`update documents set deleted_at = now() where id = ${prev.id} and deleted_at is null`;
          await tx`update orders set remarks_answer_doc_id = ${doc.id} where id = ${order.id}`;
          await audit(tx, actor, 'remarks.answer.attach', 'order', order.id, { round: order.remarks_round, document: doc.id, items: data.rows.length, ...(prev ? { replaced: prev.id } : {}) });
        });
        res.status(201);
        return { document: publicDoc(doc), ...(await view(sql, actor, { ...order, remarks_answer_doc_id: doc.id })) };
      },
    },
  ];
}
