// Операции каркаса: проверка работы, вход, профиль, документы заявки и результат работы (1.5). Сама заявка — order-ops.mjs.
import crypto from 'node:crypto';
import { HttpError, rateLimiter, sessionCookie } from '../http/core.mjs';
import { FINAL } from '../orders/workflow.mjs';
import { orderSides, seesResults } from '../access/policy.mjs';
import { requestCode, verifyCode, endSession, SESSION_TTL_SEC } from '../auth/auth.mjs';
import { audit, oneOf, phoneFrom, publicUser, text } from './util.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DOC_KINDS = ['basis', 'other'];

// Сохранить присланный файл в хранилище и записать документ заявки (вид — основание, прочее или результат).
async function storeDocument({ sql, actor, order, req, body, providers, res }, kind) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
  let filename;
  try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
  filename = text(filename.replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
  const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
  const key = `orders/${order.id}/${crypto.randomUUID()}`;
  await providers.storage.put(key, body, mime);
  try {
    const doc = await sql.tx(async (tx) => {
      const d = await tx.one`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
                             values (${order.id}, ${actor.id}, ${filename}, ${mime}, ${body.length}, ${key}, ${kind}) returning *`;
      await audit(tx, actor, 'document.upload', 'document', d.id, { order_id: order.id, kind });
      return d;
    });
    res.status(201);
    return { document: publicDoc(doc) };
  } catch (e) {
    await providers.storage.delete(key).catch(() => {});
    throw e;
  }
}

const publicDoc = (d) => ({ id: d.id, order_id: d.order_id, kind: d.kind, filename: d.filename, mime: d.mime, size_bytes: d.size_bytes, created_at: d.created_at });

export function coreOps() {
  const authLimit = rateLimiter({ windowMs: 10 * 60_000, max: 30 });

  return [
    {
      id: 'health', method: 'GET', path: '/api/health', auth: 'public',
      publicReason: 'проверка работы для облака и автотестов; данных не отдаёт',
      async handler({ sql, cfg }) {
        await sql`select 1`;
        return { ok: true, test_data: cfg.appEnv !== 'prod' };
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
        return { user: publicUser(actor), orgs, pending_invites: inv.n };
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
      async handler({ sql, actor, order }) {
        const docs = await sql`select * from documents where order_id = ${order.id} and deleted_at is null order by created_at`;
        // Результат работы заказчик видит только после проверки (src/access/policy.mjs).
        const results = seesResults(actor, order);
        return { documents: docs.filter((d) => d.kind !== 'result' || results).map(publicDoc), results_hidden: !results };
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
        // Сданный результат остаётся: по нему идёт проверка (убрать можно, пока дело в работе).
        if (doc.kind === 'result' && order.status !== 'in_work') throw new HttpError(409, 'result_locked', 'Сданный результат удалить нельзя');
        await sql.tx(async (tx) => {
          await tx`update documents set deleted_at = now() where id = ${doc.id}`;
          await audit(tx, actor, 'document.delete', 'document', doc.id);
        });
        await providers.storage.delete(doc.storage_key);
      },
    },
  ];
}
