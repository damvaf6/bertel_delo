// Операции каркаса: проверка работы, вход, профиль, документы заявки и результат работы (1.5). Сама заявка — order-ops.mjs.
import crypto from 'node:crypto';
import { HttpError, rateLimiter, sessionCookie } from '../http/core.mjs';
import { FINAL, resultDue } from '../orders/workflow.mjs';
import { executorSignOrg, orderSides, seesResults } from '../access/policy.mjs';
import { requestCode, verifyCode, endSession, SESSION_TTL_SEC } from '../auth/auth.mjs';
import { audit, oneOf, phoneFrom, publicUser, text } from './util.mjs';
import { unreadCount } from './notify-ops.mjs';

// Подсказки первого входа по ролям (2.52; тексты — public/help.js).
export const HINTS = ['customer', 'expert', 'head', 'dispatcher'];
import { orderSignatures, orgReturns, signaturesView, signWait } from './sign-ops.mjs';
import { aiSignHints } from '../ai/ai.mjs';

// Облако принимает запрос не больше 3,5 МБ (Yandex Serverless Containers) — через ядро только до 3 МБ (2.49).
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const DOC_KINDS = ['basis', 'other'];

// Сохранить присланный файл в хранилище и записать документ заявки (вид — основание, прочее или результат).
async function storeDocument(ctx, kind) {
  const { req, body, res } = ctx;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
  let filename;
  try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
  const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
  const doc = await saveDocument(ctx, { filename, mime, buf: body, kind });
  res.status(201);
  return { document: publicDoc(doc) };
}

// Файл — в хранилище, документ — в базу (не вышло записать — файл из хранилища убирается). Также черновик → результат (2.2).
export async function saveDocument({ sql, actor, order, providers }, { filename, mime, buf, kind }) {
  const name = text(String(filename ?? '').replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
  const key = `orders/${order.id}/${crypto.randomUUID()}`;
  await providers.storage.put(key, buf, mime);
  return registerDocument({ sql, actor, order, providers }, { filename: name, mime, size: buf.length, key, kind });
}

// Файл уже в хранилище (обычная загрузка или прямая, 2.49) — записать документ; не вышло — файл убирается.
export async function registerDocument({ sql, actor, order, providers }, { filename, mime, size, key, kind }) {
  try {
    return await sql.tx(async (tx) => {
      const d = await tx.one`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
                             values (${order.id}, ${actor.id}, ${filename}, ${mime}, ${size}, ${key}, ${kind}) returning *`;
      await audit(tx, actor, 'document.upload', 'document', d.id, { order_id: order.id, kind });
      return d;
    });
  } catch (e) {
    await providers.storage.delete(key).catch(() => {});
    throw e;
  }
}

export const publicDoc = (d) => ({ id: d.id, order_id: d.order_id, kind: d.kind, filename: d.filename, mime: d.mime, size_bytes: d.size_bytes, created_at: d.created_at });

// Лимит запросов входа с одного адреса — 30 за 10 минут; поднять можно только в автотестах (AUTH_RATE_MAX, config.mjs).
// Срок близко, а своего файла результата нет (2.138); черновик от ИИ есть — подсказать собрать из него отчёт Word.
async function resultDueView(sql, order, docs, userId) {
  const due = resultDue(order, docs.filter((d) => d.kind === 'result' && d.uploaded_by === userId).length);
  if (!due) return null;
  const d = await sql.one`select count(*)::int as n from result_drafts where order_id = ${order.id}`;
  return { ...due, has_draft: d.n > 0 };
}

export function coreOps(cfg) {
  const authLimit = rateLimiter({ windowMs: 10 * 60_000, max: cfg?.authRateMax ?? 30 });

  return [
    {
      id: 'health', method: 'GET', path: '/api/health', auth: 'public',
      publicReason: 'проверка работы для облака и автотестов; данных не отдаёт',
      async handler({ sql, cfg }) {
        await sql`select 1`;
        return { ok: true, test_data: cfg.appEnv !== 'prod', ...(cfg.appEnv === 'demo' ? { demo: true } : {}) };
      },
    },
    {
      id: 'auth.code', method: 'POST', path: '/api/auth/code', auth: 'public',
      publicReason: 'запрос кода входа; лимиты по номеру и адресу',
      rateLimit: (ip) => authLimit(`code:${ip}`),
      async handler(ctx) {
        const { ttlSec, channel } = await requestCode(ctx, phoneFrom(ctx.body?.phone), ctx.body?.channel ?? 'sms');
        return { sent: true, ttl_sec: ttlSec, channel };
      },
    },
    {
      id: 'auth.verify', method: 'POST', path: '/api/auth/verify', auth: 'public',
      publicReason: 'ввод кода входа; лимиты попыток по номеру и адресу',
      rateLimit: (ip) => authLimit(`verify:${ip}`),
      async handler(ctx) {
        const { user, token } = await verifyCode(ctx, phoneFrom(ctx.body?.phone), String(ctx.body?.code ?? ''));
        ctx.res.setHeader('Set-Cookie', sessionCookie(ctx.cfg, token, SESSION_TTL_SEC));
        return { user: publicUser(user) };
      },
    },
    {
      id: 'auth.logout', method: 'POST', path: '/api/auth/logout', auth: 'user', access: 'self',
      async handler({ sql, actor, res, cfg }) {
        await endSession(sql, actor.tokenHash);
        res.setHeader('Set-Cookie', sessionCookie(cfg, '', 0));
      },
    },
    {
      id: 'me', method: 'GET', path: '/api/me', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const orgs = await sql`
          select m.org_id, m.role, o.name from org_members m join organizations o on o.id = m.org_id
          where m.user_id = ${actor.id} order by o.name`;
        const inv = await sql.one`
          select count(*)::int as n from org_invites
          where phone = ${actor.phone} and accepted_at is null and declined_at is null and revoked_at is null and expires_at > now()`;
        const seen = await sql.one`select hints_seen from users where id = ${actor.id}`;
        return { user: publicUser(actor), orgs, pending_invites: inv.n, unread_notifications: await unreadCount(sql, actor.id), hints_seen: seen.hints_seen };
      },
    },
    {
      // Подсказка «С чего начать» закрыта (2.52): больше не показывается этому человеку ни на одном устройстве.
      id: 'me.hints', method: 'POST', path: '/api/me/hints', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        const hint = oneOf(body?.hint, HINTS, 'Подсказка');
        const row = (await sql.one`update users set hints_seen = array_append(hints_seen, ${hint})
                                   where id = ${actor.id} and not (${hint} = any(hints_seen)) returning hints_seen`)
          || (await sql.one`select hints_seen from users where id = ${actor.id}`);
        return { hints_seen: row.hints_seen };
      },
    },
    {
      id: 'me.update', method: 'PATCH', path: '/api/me', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        const fullName = text(body?.full_name, 'Имя', 200);
        const user = await sql.tx(async (tx) => {
          const u = await tx.one`update users set full_name = ${fullName} where id = ${actor.id} returning *`;
          await audit(tx, actor, 'user.update', 'user', actor.id);
          return u;
        });
        return { user: publicUser(user) };
      },
    },
    {
      id: 'documents.list', method: 'GET', path: '/api/orders/:id/documents', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        const docs = await sql`select * from documents where order_id = ${order.id} and deleted_at is null order by created_at`;
        // Результат работы заказчик видит только после проверки (src/access/policy.mjs); вместе с ним — подписи УКЭП эксперта
        // и организации (2.5, 2.5а).
        const results = seesResults(actor, order);
        const signs = results ? await orderSignatures(sql, order.id) : new Map();
        const required = registry.signatureRequired(order.module, order.service);
        const signOrg = results && required ? await executorSignOrg(sql, order.executor_user_id) : null;
        // Возвраты руководителя организации с замечаниями (2.27) — только самому исполнителю.
        const mine = order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
        // Перед подписью (2.136): свой неподписанный файл результата в работе — проверял ли его ИИ и что нашёл. Только исполнителю.
        const unsigned = mine && required && order.status === 'in_work'
          ? docs.filter((d) => d.kind === 'result' && d.uploaded_by === actor.id && !signs.get(d.id)?.expert).map((d) => d.id) : [];
        const aiHints = await aiSignHints(sql, registry, order, unsigned);
        return {
          documents: docs.filter((d) => d.kind !== 'result' || results)
            .map((d) => (d.kind === 'result' ? { ...publicDoc(d), signatures: signaturesView(signs.get(d.id)),
              // Исполнителю — свой ли файл: после передачи дела файлы прежнего эксперта в сдачу не идут (2.110).
              ...(mine ? { own: d.uploaded_by === actor.id } : {}), ...(aiHints.has(d.id) ? { ai_check: aiHints.get(d.id) } : {}) } : publicDoc(d))),
          results_hidden: !results,
          signature_required: required,
          // От какой организации нужна вторая подпись (null — только эксперт).
          signature_org: signOrg?.name ?? null,
          ...(mine ? { org_returns: await orgReturns(sql, order.id) } : {}),
          // Срок через 1–2 дня или прошёл, а своего файла результата нет (2.138) — предупреждение исполнителю; есть ли черновик.
          ...(mine ? { result_due: await resultDueView(sql, order, docs, actor.id) } : {}),
          // Очередь подписи (2.99): подписал эксперт, организация ещё нет — сколько ждёт и можно ли напомнить. Только исполнителю.
          ...(mine && signOrg ? { sign_wait: order.status === 'in_work' ? await signWait(sql, order) : null } : {}),
        };
      },
    },
    {
      id: 'documents.upload', method: 'POST', path: '/api/orders/:id/documents', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      body: 'raw', limit: MAX_FILE_BYTES,
      async handler(ctx) {
        if (FINAL.includes(ctx.order.status)) throw new HttpError(409, 'order_final', 'Заявка завершена — файлы не добавляются');
        // Вид документа: основание (например, определение суда) или прочее. Результат загружает только исполнитель.
        const kind = oneOf(ctx.req.get('x-doc-kind') || 'other', DOC_KINDS, 'Вид документа');
        return storeDocument(ctx, kind);
      },
    },
    {
      // Результат работы: исполнитель загружает, пока дело у него в работе. Заказчику он виден только после проверки.
      id: 'results.upload', method: 'POST', path: '/api/orders/:id/results', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      body: 'raw', limit: MAX_FILE_BYTES,
      async handler(ctx) {
        if (!orderSides(ctx.actor, ctx.order).includes('executor')) throw new HttpError(403, 'forbidden', 'Результат загружает исполнитель');
        if (ctx.order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Результат добавляется, пока дело в работе');
        return storeDocument(ctx, 'result');
      },
    },
    {
      id: 'documents.link', method: 'GET', path: '/api/documents/:id/link', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers }) {
        const url = await providers.storage.link(doc.storage_key, { filename: doc.filename });
        await audit(sql, actor, 'document.link', 'document', doc.id);
        return { url };
      },
    },
    {
      id: 'documents.delete', method: 'DELETE', path: '/api/documents/:id', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'write' },
      async handler({ sql, actor, subject: doc, order, providers }) {
        if (FINAL.includes(order.status)) throw new HttpError(409, 'order_final', 'Заявка завершена — файлы не удаляются');
        // Основание отправленной заявки остаётся: по нему заявку приняли в работу.
        if (doc.kind === 'basis' && order.status !== 'new') throw new HttpError(409, 'basis_locked', 'Основание отправленной заявки удалить нельзя');
        // Фото дистанционного осмотра (2.3) — свидетельство осмотра со временем и геометкой: не удаляются.
        if (doc.kind === 'inspection') throw new HttpError(409, 'inspection_locked', 'Фото осмотра удалить нельзя');
        // Сданный результат остаётся: по нему идёт проверка (убрать можно, пока дело в работе).
        if (doc.kind === 'result' && order.status !== 'in_work') throw new HttpError(409, 'result_locked', 'Сданный результат удалить нельзя');
        await sql.tx(async (tx) => {
          await tx`update documents set deleted_at = now() where id = ${doc.id}`;
          // Файл к запрошенному исполнителем документу (2.64) удалён — просьба снова ждёт заказчика.
          await tx`update doc_requests set document_id = null, fulfilled_at = null where document_id = ${doc.id}`;
          await audit(tx, actor, 'document.delete', 'document', doc.id);
        });
        await providers.storage.delete(doc.storage_key);
        // Подписи удалённого файла (2.5, 2.5а) больше не нужны: записи остаются в истории, файлы подписей убираются.
        for (const sig of await sql`select storage_key from document_signatures where document_id = ${doc.id}`) await providers.storage.delete(sig.storage_key);
      },
    },
  ];
}
