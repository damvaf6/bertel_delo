// Операции каркаса: проверка работы, вход, профиль, заявки (заготовка), документы.
import crypto from 'node:crypto';
import { HttpError, rateLimiter, sessionCookie } from '../http/core.mjs';
import { memberOf, orderLevel, visibleOrdersFilter } from '../access/policy.mjs';
import { requestCode, verifyCode, endSession, SESSION_TTL_SEC } from '../auth/auth.mjs';
import { audit, phoneFrom, publicUser, text, uuidFrom } from './util.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LEVEL_NAME = ['none', 'read', 'write', 'manage'];

const publicDoc = (d) => ({ id: d.id, order_id: d.order_id, filename: d.filename, mime: d.mime, size_bytes: d.size_bytes, created_at: d.created_at });

// Заявка наружу: с названием организации и тем, кто её ведёт (имя, без телефона).
async function orderView(sql, order) {
  const extra = await sql.one`
    select o.name as org_name, u.full_name as responsible_name
    from users u left join organizations o on o.id = ${order.org_id}
    where u.id = ${order.owner_user_id}`;
  return { ...order, org_name: extra?.org_name ?? null, responsible_name: extra?.responsible_name ?? '' };
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
      id: 'orders.create', method: 'POST', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        const title = text(body?.title, 'Название', 300);
        const orgId = body?.org_id == null ? null : uuidFrom(body.org_id, 'Организация не найдена');
        // Заявку от имени организации создаёт только её участник.
        if (orgId !== null && !memberOf(actor, orgId)) throw new HttpError(404, 'not_found', 'Организация не найдена');
        const order = await sql.tx(async (tx) => {
          const o = await tx.one`insert into orders (owner_user_id, org_id, title) values (${actor.id}, ${orgId}, ${title}) returning *`;
          await audit(tx, actor, 'order.create', 'order', o.id);
          return o;
        });
        res.status(201);
        return { order: await orderView(sql, order) };
      },
    },
    {
      id: 'orders.list', method: 'GET', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const f = visibleOrdersFilter(actor);
        // Личные — свои; от организации — свои, пока состоишь в ней; руководитель и старший — все дела организации.
        const orders = await sql`
          select r.*, o.name as org_name, u.full_name as responsible_name
          from orders r left join organizations o on o.id = r.org_id join users u on u.id = r.owner_user_id
          where ${!!f.all}
             or (r.owner_user_id = ${f.userId ?? null} and (r.org_id is null or r.org_id = any(${f.memberOrgIds ?? []}::uuid[])))
             or r.org_id = any(${f.allOrgIds ?? []}::uuid[])
          order by r.created_at desc limit 200`;
        return { orders };
      },
    },
    {
      id: 'orders.get', method: 'GET', path: '/api/orders/:id', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) {
        return { order: await orderView(sql, order), access: LEVEL_NAME[orderLevel(actor, order)] };
      },
    },
    {
      // Руководитель или старший передаёт дело организации другому её участнику.
      id: 'orders.transfer', method: 'PATCH', path: '/api/orders/:id/responsible', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'manage' },
      async handler({ sql, actor, order, body }) {
        const userId = uuidFrom(body?.user_id, 'Сотрудник не найден');
        const updated = await sql.tx(async (tx) => {
          const target = await tx.one`select 1 from org_members where org_id = ${order.org_id} and user_id = ${userId}`;
          if (!target) throw new HttpError(404, 'not_found', 'Сотрудник не найден в этой организации');
          const o = await tx.one`update orders set owner_user_id = ${userId} where id = ${order.id} returning *`;
          await audit(tx, actor, 'order.transfer', 'order', order.id, { from: order.owner_user_id, to: userId });
          return o;
        });
        return { order: await orderView(sql, updated) };
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
