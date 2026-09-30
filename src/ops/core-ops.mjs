// Операции каркаса: проверка работы, вход, заявки (заготовка), документы.
import crypto from 'node:crypto';
import { HttpError, rateLimiter, sessionCookie } from '../http/core.mjs';
import { memberOf, visibleOrdersFilter } from '../access/policy.mjs';
import { normPhone, requestCode, verifyCode, endSession, SESSION_TTL_SEC } from '../auth/auth.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const publicUser = (u) => ({ id: u.id, phone: u.phone, full_name: u.full_name, platform_role: u.platform_role });
const publicDoc = (d) => ({ id: d.id, order_id: d.order_id, filename: d.filename, mime: d.mime, size_bytes: d.size_bytes, created_at: d.created_at });

function text(value, field, max) {
  const v = String(value ?? '').trim();
  if (!v || v.length > max) throw new HttpError(400, 'bad_input', `Поле «${field}»: от 1 до ${max} символов`);
  return v;
}

function phoneFrom(body) {
  const phone = normPhone(body?.phone);
  if (!phone) throw new HttpError(400, 'bad_phone', 'Введите номер мобильного телефона России');
  return phone;
}

async function audit(sql, actor, action, subjectType, subjectId, details = {}) {
  await sql`insert into audit_log (actor_id, action, subject_type, subject_id, details)
            values (${actor.id}, ${action}, ${subjectType}, ${String(subjectId)}, ${JSON.stringify(details)})`;
}

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
        const { ttlSec } = await requestCode(ctx, phoneFrom(ctx.body));
        return { sent: true, ttl_sec: ttlSec };
      },
    },
    {
      id: 'auth.verify', method: 'POST', path: '/api/auth/verify', auth: 'public',
      publicReason: 'ввод кода входа; лимиты попыток по номеру и адресу',
      rateLimit: (ip) => authLimit(`verify:${ip}`),
      async handler(ctx) {
        const { user, token } = await verifyCode(ctx, phoneFrom(ctx.body), String(ctx.body?.code ?? ''));
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
      async handler({ actor }) {
        return { user: publicUser(actor), orgs: actor.orgs };
      },
    },
    {
      id: 'orders.create', method: 'POST', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        const title = text(body?.title, 'Название', 300);
        const orgId = body?.org_id ?? null;
        // Заявку от имени организации создаёт только её участник.
        if (orgId !== null && !memberOf(actor, orgId)) throw new HttpError(404, 'org_not_found', 'Организация не найдена');
        const order = await sql.tx(async (tx) => {
          const o = await tx.one`insert into orders (owner_user_id, org_id, title) values (${actor.id}, ${orgId}, ${title}) returning *`;
          await audit(tx, actor, 'order.create', 'order', o.id);
          return o;
        });
        res.status(201);
        return { order };
      },
    },
    {
      id: 'orders.list', method: 'GET', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const f = visibleOrdersFilter(actor);
        const orders = f.all
          ? await sql`select * from orders order by created_at desc limit 200`
          : await sql`select * from orders where owner_user_id = ${f.userId} or org_id = any(${f.headOrgIds}::uuid[])
                      order by created_at desc limit 200`;
        return { orders };
      },
    },
    {
      id: 'orders.get', method: 'GET', path: '/api/orders/:id', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ order }) {
        return { order };
      },
    },
    {
      id: 'documents.list', method: 'GET', path: '/api/orders/:id/documents', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, order }) {
        const docs = await sql`select * from documents where order_id = ${order.id} and deleted_at is null order by created_at`;
        return { documents: docs.map(publicDoc) };
      },
    },
    {
      id: 'documents.upload', method: 'POST', path: '/api/orders/:id/documents', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      body: 'raw', limit: MAX_FILE_BYTES,
      async handler({ sql, actor, order, req, body, providers, res }) {
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
        let filename;
        try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
        filename = text(filename.replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
        const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
        const key = `orders/${order.id}/${crypto.randomUUID()}`;
        await providers.storage.put(key, body, mime);
        try {
          const doc = await sql.tx(async (tx) => {
            const d = await tx.one`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key)
                                   values (${order.id}, ${actor.id}, ${filename}, ${mime}, ${body.length}, ${key}) returning *`;
            await audit(tx, actor, 'document.upload', 'document', d.id, { order_id: order.id });
            return d;
          });
          res.status(201);
          return { document: publicDoc(doc) };
        } catch (e) {
          await providers.storage.delete(key).catch(() => {});
          throw e;
        }
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
      async handler({ sql, actor, subject: doc, providers }) {
        await sql.tx(async (tx) => {
          await tx`update documents set deleted_at = now() where id = ${doc.id}`;
          await audit(tx, actor, 'document.delete', 'document', doc.id);
        });
        await providers.storage.delete(doc.storage_key);
      },
    },
  ];
}
