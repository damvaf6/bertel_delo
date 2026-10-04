// ИИ (задача 1.8): вход через проблему, личный ассистент по делам, ИИ-проверка результата по правилам модуля, сведения
// о модели для администратора. Модель — настройка (src/providers/ai.mjs); кто что видит — src/access/policy.mjs.
// ИИ только отвечает и подсказывает: заявку создаёт человек кнопкой, отметки проверки ставит человек.
import { HttpError } from '../http/core.mjs';
import { aiReviewSide, assistantOrderAllowed, assistantScopeAllowed } from '../access/policy.mjs';
import { AI_DRIVER_NAME } from '../providers/ai.mjs';
import {
  DISCLAIMER, aiReviewView, askAi, assistantMessages, monthUsage, cleanProblemAnswer, cleanReviewAnswer, orderBrief, problemMessages, reviewMessages,
} from '../ai/ai.mjs';
import { READ_MAX_BYTES, extractPages, readableKind } from '../ai/extract.mjs';
import { runAutoChecks } from '../ai/report-checks.mjs';
import { loadDossier } from '../dossier/dossier.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { insertOrder, listVisibleOrders } from './order-ops.mjs';
import { audit, quoted, text, uuidFrom } from './util.mjs';

const PROBLEM_MAX = 4000;
const QUESTION_MAX = 2000;
const HISTORY = 20;
// Модели уходит не больше: на файл и на все файлы (окно YandexGPT Pro — 32 тыс. токенов вместе с ответом).
const READ_MAX_CHARS = 40_000;
const TOTAL_MAX_CHARS = 50_000;
const FILES_MAX = 5;
// Отметка в ai_reviews.model, когда модель не ответила и показаны только автоматические находки.
export const AUTO_ONLY = 'auto';

const consultationView = (c) => ({ id: c.id, problem: c.problem, ...c.answer, order_id: c.order_id, disclaimer: DISCLAIMER, created_at: c.created_at });

// Память ассистента: null — личная; иначе — организация, где вошедший состоит (чужая — «не найдено»).
function scopeFrom(actor, value) {
  if (value === undefined || value === null || value === '') return null;
  const id = uuidFrom(value, 'Организация не найдена');
  if (!assistantScopeAllowed(actor, id)) throw new HttpError(404, 'not_found', 'Организация не найдена');
  return id;
}

// Свои организации с названиями — разделы памяти ассистента.
const myOrgs = (sql, actor) => sql`select id, name from organizations where id = any(${actor.orgs.map((m) => m.org_id)}::uuid[]) order by name`;

// Сообщения памяти, которые можно показать и отдать модели: о заявке — только пока она видна в этой памяти.
async function scopeHistory(sql, actor, orgId, limit) {
  const rows = await sql`select * from assistant_messages where user_id = ${actor.id} and org_id is not distinct from ${orgId}
                         order by id desc limit ${limit}`;
  const ids = [...new Set(rows.map((m) => m.order_id).filter(Boolean))];
  const orders = ids.length ? await sql`select * from orders where id = any(${ids}::uuid[])` : [];
  const ok = new Set(orders.filter((o) => assistantOrderAllowed(actor, o, orgId)).map((o) => o.id));
  const visible = rows.filter((m) => !m.order_id || ok.has(m.order_id)).reverse();
  return { messages: visible, hidden: rows.length - visible.length };
}

// Страницы, которые модель должна увидеть в первую очередь, если весь отчёт не помещается: начало (титул, оглавление,
// выводы), задание, расчёт, согласование и итог. Остальные — по порядку, пока есть место.
const KEY_PAGE = /(?:основные факты и выводы|задание на оценку|итогов\S* (?:величин|стоимост)|согласовани|обобщение результатов|расч[её]т\S* (?:рыночной )?стоимост|корректировк|рыночная стоимость[^.]{0,120}составляет|выводы|заключение эксперта)/iu;

export function pagesForModel(pages, limit) {
  const marked = pages.map((p, i) => (pages.length > 1 ? `--- стр. ${i + 1} ---\n${p}` : p));
  const full = marked.join('\n');
  if (full.length <= limit) return { text: full, truncated: false };
  const order = [
    ...marked.map((_, i) => i).filter((i) => i < 4),
    ...marked.map((_, i) => i).filter((i) => i >= 4 && KEY_PAGE.test(pages[i])),
    ...marked.map((_, i) => i),
  ];
  const take = new Set();
  let used = 0;
  for (const i of order) {
    if (take.has(i)) continue;
    const len = marked[i].length + 1;
    if (used + len > limit) continue;
    take.add(i);
    used += len;
  }
  if (!take.size) return { text: marked[0].slice(0, limit), truncated: true };
  const text = [...take].sort((a, b) => a - b).map((i) => marked[i]).join('\n');
  const skipped = marked.length - take.size;
  return { text: `${text}\n(страниц не передано: ${skipped} из ${marked.length})`, truncated: true };
}

// Отчёт для ИИ-проверки (задача 2.1): текст, PDF и Word читаются по страницам; что не прочитано — text: null.
// Автоматические правила (report-checks.mjs) смотрят все страницы; модели уходит не больше READ_MAX_CHARS на файл и
// TOTAL_MAX_CHARS на все файлы — сначала главные страницы.
async function resultDocs(sql, storage, order) {
  const docs = await sql`select * from documents where order_id = ${order.id} and kind = 'result' and deleted_at is null
                         and uploaded_by = ${order.executor_user_id} order by created_at limit ${FILES_MAX}`;
  const out = [];
  let left = TOTAL_MAX_CHARS;
  for (const d of docs) {
    let got = null;
    if (readableKind(d.filename, d.mime) && d.size_bytes <= READ_MAX_BYTES) {
      const buf = await storage.get(d.storage_key);
      if (buf) got = await extractPages(buf, d.filename, d.mime);
    }
    if (!got) { out.push({ id: d.id, name: d.filename, kind: null, pages: null, text: null, truncated: false }); continue; }
    const { text, truncated } = pagesForModel(got.pages, Math.max(0, Math.min(READ_MAX_CHARS, left)));
    left -= text.length;
    out.push({ id: d.id, name: d.filename, kind: got.kind, pages: got.pages, text, truncated });
  }
  return out;
}

export function aiOps() {
  return [
    {
      // Вход через проблему: человек описывает вопрос своими словами — ИИ разъясняет, что сделать самому и к кому идти.
      id: 'ai.problem', method: 'POST', path: '/api/ai/problem', auth: 'user', access: 'self',
      async handler(ctx) {
        const { sql, actor, body, registry, res } = ctx;
        const problem = text(body?.text, 'Опишите, что случилось', PROBLEM_MAX);
        const out = await askAi(ctx, actor, 'problem', problemMessages(registry, problem));
        const answer = cleanProblemAnswer(registry, out.text, problem);
        const c = await sql.one`insert into ai_consultations (user_id, problem, answer, model)
                                values (${actor.id}, ${problem}, ${JSON.stringify(answer)}, ${out.model}) returning *`;
        res.status(201);
        return { consultation: consultationView(c) };
      },
    },
    {
      // Заявка из разбора: услуга — предложенная ИИ или выбранная человеком; описание проблемы — в «Что ещё важно знать».
      // Создаётся черновиком: человек проверяет, дополняет и отправляет сам.
      id: 'ai.consultation.order', method: 'POST', path: '/api/ai/consultations/:id/order', auth: 'user',
      access: { resource: 'consultation', param: 'id', need: 'write' },
      async handler({ sql, actor, consultation, body, registry, res }) {
        const want = body?.service ? String(body.service).split('/') : null;
        const s = consultation.answer.service;
        const def = want ? registry.service(want[0], want[1]) : s ? registry.service(s.module, s.service) : null;
        if (!def) throw new HttpError(400, 'bad_service', 'Выберите услугу');
        const orgId = body?.org_id == null || body.org_id === '' ? null : uuidFrom(body.org_id, 'Организация не найдена');
        if (orgId !== null && !actor.orgs.some((m) => m.org_id === orgId)) throw new HttpError(404, 'not_found', 'Организация не найдена');
        const sameService = s && s.module === def.module.id && s.service === def.service.id;
        const fields = sameService ? { ...consultation.answer.fields } : {};
        const comment = def.fields.find((f) => f.id === 'comment' && f.type === 'longtext');
        if (comment) fields.comment = consultation.problem.slice(0, comment.max ?? 2000);
        const title = (sameService && consultation.answer.title) || def.service.name;
        const order = await sql.tx(async (tx) => {
          const cur = await tx.one`select order_id from ai_consultations where id = ${consultation.id} for update`;
          if (cur.order_id) throw new HttpError(409, 'already_ordered', 'Заявка по этому разбору уже создана');
          const o = await insertOrder(tx, actor, def, { title, orgId, fields, via: 'ai_problem' });
          await tx`update ai_consultations set order_id = ${o.id} where id = ${consultation.id}`;
          return o;
        });
        res.status(201);
        return { order_id: order.id };
      },
    },
    {
      // Ассистент: разделы памяти (личная и по каждой своей организации), сообщения выбранного, заявки, которые можно взять.
      id: 'assistant.get', method: 'GET', path: '/api/assistant', auth: 'user', access: 'self',
      async handler({ sql, actor, query }) {
        const orgId = scopeFrom(actor, query.org);
        const { messages, hidden } = await scopeHistory(sql, actor, orgId, 200);
        const orders = (await listVisibleOrders(sql, actor)).filter((o) => assistantOrderAllowed(actor, o, orgId));
        return {
          scopes: [{ org_id: null, name: 'Личное' }, ...(await myOrgs(sql, actor)).map((o) => ({ org_id: o.id, name: o.name }))],
          org_id: orgId,
          messages: messages.map((m) => ({ id: String(m.id), role: m.role, body: m.body, order_id: m.order_id, at: m.at })),
          hidden,
          orders: orders.map((o) => ({ id: o.id, title: o.title, status: o.status })),
        };
      },
    },
    {
      id: 'assistant.ask', method: 'POST', path: '/api/assistant', auth: 'user', access: 'self',
      async handler(ctx) {
        const { sql, actor, body, registry, res } = ctx;
        const orgId = scopeFrom(actor, body?.org_id);
        const question = text(body?.text, 'Вопрос', QUESTION_MAX);
        let order = null;
        if (body?.order_id) {
          order = await sql.one`select * from orders where id = ${uuidFrom(body.order_id, 'Заявка не найдена')}`;
          if (!order || !assistantOrderAllowed(actor, order, orgId)) throw new HttpError(404, 'not_found', 'Заявка не найдена');
        }
        const { messages: history } = await scopeHistory(sql, actor, orgId, HISTORY);
        const org = orgId ? (await myOrgs(sql, actor)).find((o) => o.id === orgId) : null;
        const out = await askAi(ctx, actor, 'assistant', assistantMessages({
          scopeName: org ? `организация ${quoted(org.name)}` : 'личное', history, brief: order ? orderBrief(registry, order) : null, question,
        }));
        const answer = out.text.trim().slice(0, 8000);
        const [q, a] = await sql.tx(async (tx) => [
          await tx.one`insert into assistant_messages (user_id, org_id, role, body, order_id)
                       values (${actor.id}, ${orgId}, 'user', ${question}, ${order?.id ?? null}) returning *`,
          await tx.one`insert into assistant_messages (user_id, org_id, role, body, order_id, model)
                       values (${actor.id}, ${orgId}, 'assistant', ${answer}, ${order?.id ?? null}, ${out.model}) returning *`,
        ]);
        res.status(201);
        return { messages: [q, a].map((m) => ({ id: String(m.id), role: m.role, body: m.body, order_id: m.order_id, at: m.at })) };
      },
    },
    {
      // Очистить свою память в выбранном разделе (только свою; другие разделы и чужая память не трогаются).
      id: 'assistant.clear', method: 'DELETE', path: '/api/assistant', auth: 'user', access: 'self',
      async handler({ sql, actor, query }) {
        const orgId = scopeFrom(actor, query.org);
        const rows = await sql`delete from assistant_messages where user_id = ${actor.id} and org_id is not distinct from ${orgId} returning id`;
        await audit(sql, actor, 'assistant.clear', 'user', actor.id, { org: orgId, count: rows.length });
      },
    },
    {
      // ИИ-проверка результата по правилам модуля: исполнитель — перед сдачей, диспетчер — на проверке.
      // Подсказки ничего не отмечают сами: «в порядке / замечание» ставит диспетчер.
      id: 'review.ai', method: 'POST', path: '/api/orders/:id/review/ai', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, providers, res } = ctx;
        const side = aiReviewSide(actor, order);
        if (!side) throw new HttpError(403, 'forbidden', 'ИИ-проверку запускает исполнитель перед сдачей или диспетчер на проверке');
        const rules = registry.checks(order.module, order.service);
        const files = await resultDocs(sql, providers.storage, order);
        if (!files.length) throw new HttpError(400, 'no_result', 'Сначала добавьте файл результата');
        // Автоматические правила — по всему тексту, до модели: их находки модель видит и не повторяет.
        // Сверка с досье исполнителя (2.14): аттестат, СРО, полисы, диплом — номера, суммы и сроки на дату отчёта.
        const dossier = { items: order.executor_user_id ? await loadDossier(sql, order.executor_user_id) : [], today: todayMsk() };
        const basis = { kind: order.basis_kind, number: order.basis_number };
        const auto = runAutoChecks([...new Set(rules.flatMap((r) => r.auto ?? []))], files, { fields: order.fields ?? {}, dossier, basis });
        const found = Object.fromEntries(rules.map((r) => [r.id, (r.auto ?? []).flatMap((a) => auto[a] ?? [])]));
        // Модель недоступна или лимит исчерпан, но автоматические находки есть — показываем их, а не ошибку.
        let out;
        try {
          out = await askAi(ctx, actor, 'review', reviewMessages({ rules, brief: orderBrief(registry, order), files, found }));
        } catch (e) {
          if (!Object.values(found).some((f) => f.length) || !['ai_unavailable', 'ai_limit', 'ai_budget'].includes(e.code)) throw e;
          out = { text: '', model: AUTO_ONLY };
        }
        const items = cleanReviewAnswer(rules, out.text, files, found);
        const round = side === 'executor' ? order.review_round + 1 : order.review_round;
        await sql`insert into ai_reviews (order_id, round, requested_by, side, model, items, files)
                  values (${order.id}, ${round}, ${actor.id}, ${side}, ${out.model}, ${JSON.stringify(items)},
                          ${JSON.stringify(files.map((f) => ({ id: f.id, name: f.name, read: f.text !== null, truncated: f.truncated })))})`;
        await audit(sql, actor, 'review.ai', 'order', order.id, { round, side });
        res.status(201);
        return { ai: await aiReviewView(sql, order) };
      },
    },
    {
      // Какая модель сейчас работает и сколько обращений за сутки — администратору.
      id: 'ai.status', method: 'GET', path: '/api/admin/ai', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, cfg }) {
        const day = await sql.one`select count(*)::int as total, count(*) filter (where not ok)::int as failed
                                  from ai_usage where at > now() - interval '1 day'`;
        const m = await monthUsage(sql);
        return {
          month: { spent_rub: m.kop / 100, tokens: m.tokens, calls: m.calls, budget_rub: cfg.ai.budgetRub || null, price_rub_per_1k: cfg.ai.priceRubPer1k },
          primary: { driver: cfg.providers.ai, name: AI_DRIVER_NAME[cfg.providers.ai] },
          fallback: cfg.ai.fallback ? { driver: cfg.ai.fallback, name: AI_DRIVER_NAME[cfg.ai.fallback] } : null,
          daily_limit: cfg.ai.dailyLimit,
          day,
        };
      },
    },
  ];
}
