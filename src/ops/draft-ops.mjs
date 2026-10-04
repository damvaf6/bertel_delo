// Черновик заключения от ИИ (задача 2.2): исполнитель получает черновик по данным заявки, документам и списку фото, правит
// его в кабинете и сам прикладывает итоговый файл результата (Word). Заказчик черновика не видит; ИИ ничего не выдаёт
// заказчику сам — результат по-прежнему проходит проверку диспетчера (1.5). Разделы черновика — в описании модуля.
import { HttpError } from '../http/core.mjs';
import { editsDraft, seesDraft } from '../access/policy.mjs';
import { DRAFT_GAP, DRAFT_MAX, askAi, cleanDraftAnswer, draftMessages, orderBrief } from '../ai/ai.mjs';
import { READ_MAX_BYTES, extractPages, readableKind } from '../ai/extract.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { fillTables, orderSections, reportFor, tablesBrief } from '../docs/report.mjs';
import { APPROACHES } from '../modules/index.mjs';
import { analogsBrief } from '../analogs/analogs.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit } from './util.mjs';
import { fillDraft, itemLine, loadDossier } from '../dossier/dossier.mjs';

const PHOTOS_MAX = 40;
const DOCS_MAX = 5;
const DOC_CHARS = 10_000;
const DOCS_CHARS = 20_000;

const isPhoto = (d) => /^image\//.test(d.mime) || /\.(jpe?g|png|heic|heif|webp)$/i.test(d.filename);
const dayRu = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

async function latest(sql, orderId) {
  return sql.one`select d.*, (select count(*)::int from result_drafts x where x.order_id = d.order_id) as versions
                 from result_drafts d where d.order_id = ${orderId} order by d.id desc limit 1`;
}

const draftView = (d, actor) => d && {
  id: String(d.id), source: d.source, body: d.body, model: d.model, inputs: d.inputs, at: d.at, versions: d.versions,
  mine: d.author_id === actor.id,
};

function guard(actor, order) {
  if (!seesDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Черновик заключения видят исполнитель и диспетчер');
}

function guardEdit(actor, order) {
  guard(actor, order);
  if (!editsDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Черновик готовит и правит исполнитель, пока дело в работе');
}

// Человек правил ту версию, которую видел: если с тех пор появилась другая — «уже изменился» (в соседней вкладке и т. п.).
function sameBase(cur, from) {
  const seen = from === null || from === undefined || from === '' ? null : String(from);
  if ((cur ? String(cur.id) : null) !== seen) throw new HttpError(409, 'draft_changed', 'Черновик уже изменился, обновите страницу');
}

// Что ИИ получает: фото (только имена и даты — сами снимки модель не видит) и текст документов заказчика (основание и прочее).
async function draftInputs(sql, storage, order) {
  const docs = await sql`select * from documents where order_id = ${order.id} and deleted_at is null order by created_at`;
  const photos = docs.filter(isPhoto).slice(0, PHOTOS_MAX).map((d) => ({ id: d.id, name: d.filename, at: dayRu(d.created_at) }));
  const texts = [];
  let left = DOCS_CHARS;
  for (const d of docs.filter((x) => x.kind !== 'result' && !isPhoto(x)).slice(0, DOCS_MAX)) {
    let got = null;
    if (readableKind(d.filename, d.mime) && d.size_bytes <= READ_MAX_BYTES && left > 0) {
      const buf = await storage.get(d.storage_key);
      if (buf) got = await extractPages(buf, d.filename, d.mime);
    }
    const full = got ? got.pages.join('\n') : null;
    const t = full === null ? null : full.slice(0, Math.min(DOC_CHARS, left));
    if (t !== null) left -= t.length;
    texts.push({ id: d.id, name: d.filename, text: t, truncated: full !== null && full.length > t.length });
  }
  return { photos, docs: texts };
}

// Данные с объекта от помощника (экспресс, 2.4): последний завершённый выезд — строками «подпись: значение».
async function onsiteBrief(sql, registry, order) {
  const ex = registry.express(order.module, order.service);
  if (!ex) return null;
  const v = await sql.one`select data, finished_at from onsite_visits where order_id = ${order.id} and finished_at is not null
                          order by finished_at desc limit 1`;
  if (!v) return null;
  const lines = ex.fields.filter((f) => v.data?.[f.id] !== undefined).map((f) => {
    const x = v.data[f.id];
    return `${f.label}: ${f.type === 'select' ? f.options.find((o) => o.id === x)?.name ?? x : x}`;
  });
  return [`ДАННЫЕ С ОБЪЕКТА (выезд помощника ${dayRu(v.finished_at)}):`, ...lines].join('\n');
}

export function draftOps() {
  return [
    {
      id: 'draft.get', method: 'GET', path: '/api/orders/:id/draft', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        guard(actor, order);
        const sections = orderSections(registry, order);
        return {
          draft: draftView(await latest(sql, order.id), actor),
          sections,
          can_edit: editsDraft(actor, order),
          can_ai: editsDraft(actor, order) && sections.length > 0,
          // Подходы к оценке (2.33): список — если исполнитель их выбирает для этой услуги; chosen — что отмечено.
          approaches: registry.approachesFor(order.module, order.service)
            ? { list: Object.entries(APPROACHES).map(([id, name]) => ({ id, name })), chosen: order.approaches ?? null }
            : null,
        };
      },
    },
    {
      // Подготовить черновик с помощью ИИ. Прежние версии остаются в истории; текущей становится новая.
      id: 'draft.ai', method: 'POST', path: '/api/orders/:id/draft/ai', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, providers, body, res } = ctx;
        guardEdit(actor, order);
        const sections = orderSections(registry, order);
        if (!sections.length) throw new HttpError(400, 'no_draft', 'Для этой услуги черновик от ИИ не готовится');
        sameBase(await latest(sql, order.id), body?.from);
        const inputs = await draftInputs(sql, providers.storage, order);
        const onsite = await onsiteBrief(sql, registry, order);
        // Досье эксперта (2.14): сведения подставляются в разделы с пометкой dossier сами — модели они даны для связности.
        const dossier = sections.some((s) => s.dossier) ? await loadDossier(sql, actor.id) : [];
        const dossierBrief = dossier.length
          ? ['СВЕДЕНИЯ ОБ ЭКСПЕРТЕ (из досье; программа сама вставит их в нужные разделы — не повторяй и не ставь про них пометки):', ...dossier.map((i) => `- ${itemLine(i)}`)].join('\n')
          : null;
        // Подтверждённые аналоги (2.32) — модели для текста о корректировках; таблицу программа вставит в Word сама.
        const spec = registry.analogs(order.module, order.service);
        const analogs = spec ? await sql`select * from order_analogs where order_id = ${order.id} and deleted_at is null and confirmed_at is not null order by id` : [];
        const brief = [orderBrief(registry, order), onsite, dossierBrief, spec ? analogsBrief(spec, analogs) : null, tablesBrief(sections)].filter(Boolean).join('\n');
        const out = await askAi(ctx, actor, 'draft', draftMessages({ brief, sections, ...inputs }));
        // Таблицы (2.29) и сведения из досье (2.14) программа вставляет сама, под заголовками разделов.
        const text = fillDraft(fillTables(cleanDraftAnswer(sections, out.text), sections, registry, order), sections, dossier).slice(0, DRAFT_MAX);
        const seen = {
          photos: inputs.photos.map((p) => p.name),
          docs: inputs.docs.map((d) => ({ name: d.name, read: d.text !== null, truncated: d.truncated })),
          onsite: !!onsite,
          dossier: dossier.length,
          analogs: analogs.length,
        };
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          sameBase(await latest(tx, order.id), body?.from);
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, model, inputs)
                                   values (${order.id}, ${actor.id}, 'ai', ${text}, ${out.model}, ${JSON.stringify(seen)}) returning id`;
          await audit(tx, actor, 'draft.ai', 'order', order.id, { draft: String(row.id) });
          return latest(tx, order.id);
        });
        res.status(201);
        return { draft: draftView(d, actor) };
      },
    },
    {
      // Подходы к оценке, которые применяет исполнитель (2.33): от них зависят разделы черновика, таблица подходов и
      // нужны ли аналоги. Меняет только исполнитель, пока дело в работе; уже готовый черновик не переписывается.
      id: 'draft.approaches', method: 'PUT', path: '/api/orders/:id/approaches', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, body }) {
        guardEdit(actor, order);
        if (!registry.approachesFor(order.module, order.service)) throw new HttpError(400, 'no_approaches', 'Для этой услуги подходы не выбираются');
        const list = Array.isArray(body?.approaches) ? [...new Set(body.approaches)] : null;
        if (!list?.length || list.some((a) => !Object.hasOwn(APPROACHES, a))) {
          throw new HttpError(400, 'bad_input', 'Отметьте хотя бы один подход: сравнительный, затратный или доходный');
        }
        const chosen = Object.keys(APPROACHES).filter((a) => list.includes(a));
        await sql`update orders set approaches = ${chosen} where id = ${order.id}`;
        await audit(sql, actor, 'draft.approaches', 'order', order.id, { approaches: chosen });
        return { approaches: chosen, sections: orderSections(registry, { ...order, approaches: chosen }) };
      },
    },
    {
      // Сохранить правку эксперта — новой версией (видно, что написал ИИ и что поправил человек).
      id: 'draft.save', method: 'PUT', path: '/api/orders/:id/draft', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body }) {
        guardEdit(actor, order);
        const text = typeof body?.body === 'string' ? body.body.replace(/\r\n?/g, '\n').trim() : '';
        if (!text) throw new HttpError(400, 'bad_input', 'Черновик пустой');
        if (text.length > DRAFT_MAX) throw new HttpError(400, 'bad_input', `Черновик — не длиннее ${DRAFT_MAX} символов`);
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const cur = await latest(tx, order.id);
          sameBase(cur, body?.from);
          if (cur && cur.body === text) return cur;
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, inputs)
                                   values (${order.id}, ${actor.id}, 'edit', ${text}, ${JSON.stringify(cur?.inputs ?? {})}) returning id`;
          await audit(tx, actor, 'draft.save', 'order', order.id, { draft: String(row.id) });
          return latest(tx, order.id);
        });
        return { draft: draftView(d, actor) };
      },
    },
    {
      // Скачать черновик готовым файлом Word (2.29): титул, оглавление, разделы, таблицы, колонтитул; в шаблоне организации,
      // если он есть. Только сам исполнитель — дальше он правит файл в Word и прикладывает как результат. Пометки
      // «[заполнить …]» остаются в файле — их видно и в Word.
      id: 'draft.docx', method: 'GET', path: '/api/orders/:id/draft/docx', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, res } = ctx;
        guard(actor, order);
        if (order.executor_user_id !== actor.id) throw new HttpError(403, 'forbidden', 'Файл Word черновика скачивает исполнитель');
        const cur = await latest(sql, order.id);
        if (!cur) throw new HttpError(404, 'no_draft', 'Черновика ещё нет');
        const word = await reportFor(ctx, order, actor, cur.body);
        await audit(sql, actor, 'draft.docx', 'order', order.id, { draft: String(cur.id), template: word.template });
        res.set({
          'content-type': DOCX_MIME,
          'content-disposition': `attachment; filename="report.docx"; filename*=UTF-8''${encodeURIComponent(word.filename)}`,
          'cache-control': 'no-store',
        });
        res.send(word.buf);
      },
    },
    {
      // Приложить черновик файлом результата (Word). Только когда эксперт заполнил все пометки «[заполнить …]» и
      // подтвердил, что проверил текст и отвечает за него. Дальше — обычная сдача на проверку диспетчеру.
      id: 'draft.attach', method: 'POST', path: '/api/orders/:id/draft/result', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, body, res } = ctx;
        guardEdit(actor, order);
        const cur = await latest(sql, order.id);
        if (!cur) throw new HttpError(400, 'no_draft', 'Черновика ещё нет');
        sameBase(cur, body?.from);
        const gap = cur.body.match(DRAFT_GAP);
        if (gap) throw new HttpError(409, 'draft_gaps', `В черновике остались незаполненные места, например: ${gap[0].slice(0, 120)}`);
        if (body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'Подтвердите, что Вы проверили текст и отвечаете за него');
        const word = await reportFor(ctx, order, actor, cur.body);
        const doc = await saveDocument(ctx, { filename: word.filename, mime: DOCX_MIME, buf: word.buf, kind: 'result' });
        await audit(sql, actor, 'draft.attach', 'order', order.id, { draft: String(cur.id), document: doc.id, template: word.template, analogs: word.analogs });
        res.status(201);
        return { document: publicDoc(doc) };
      },
    },
  ];
}
