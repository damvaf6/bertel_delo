// Помощники автотестов: чистая база, приложение на случайном порту, вход под тестовым номером.
// Нужен локальный PostgreSQL 16: TEST_DATABASE_URL (по умолчанию postgres://postgres:postgres@localhost:5432/delo_test).
// В облако тесты не ходят. Данные — только тестовые: телефоны +7999000xxxx.
import pg from 'pg';
import { loadConfig } from '../src/config.mjs';
import { createDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';
import { createProviders } from '../src/providers/index.mjs';
import { createApp } from '../src/app.mjs';
import { signBridge } from '../src/bridge/signature.mjs';

export const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/delo_test';
export const TEST_TOKEN = 'test-control-token-local';
// Ключ моста CRM → Платформа для проверок (не настоящий; настоящий — только в Lockbox).
export const BRIDGE_SECRET = 'test-crm-bridge-secret-local-0123456789';

export function testEnv(extra = {}) {
  return {
    APP_ENV: 'test',
    DATABASE_URL: DB_URL,
    DB_SSL: 'disable',
    COOKIE_SECURE: '0',
    TEST_CONTROL_TOKEN: TEST_TOKEN,
    CRM_BRIDGE_SECRET: BRIDGE_SECRET,
    CRM_URL: 'https://crm.example.test',
    ...extra,
  };
}

// S3-совместимое хранилище для проверки (MinIO в CI). Не задано — такие проверки пропускаются.
export function s3TestEnv() {
  const e = process.env;
  if (!e.S3_TEST_ENDPOINT) return null;
  return {
    STORAGE_PROVIDER: 's3',
    S3_ENDPOINT: e.S3_TEST_ENDPOINT,
    S3_BUCKET: e.S3_TEST_BUCKET || 'delo-test',
    S3_ACCESS_KEY: e.S3_TEST_ACCESS_KEY || 'minioadmin',
    S3_SECRET_KEY: e.S3_TEST_SECRET_KEY || 'minioadmin',
    S3_PATH_STYLE: '1',
    S3_REGION: 'us-east-1',
  };
}

export async function resetDatabase(url = DB_URL) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema if exists public cascade; create schema public;');
  await c.end();
}

// modules — описания модулей-профессий, если проверке нужен свой набор (по умолчанию — модули ядра).
export async function startApp(extraEnv = {}, { modules } = {}) {
  await resetDatabase();
  const cfg = loadConfig(testEnv(extraEnv));
  const sql = createDb(cfg);
  await migrate(sql);
  const providers = createProviders(cfg);
  const app = createApp({ cfg, sql, providers, ...(modules ? { modules } : {}) });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, sql, providers, cfg, app,
    close: async () => { await new Promise((r) => server.close(r)); await sql.end(); },
  };
}

// Клиент с «браузерной» cookie: запоминает сессию после входа.
export function client(stack) {
  let cookie = '';
  const c = {
    get cookie() { return cookie; },
    async req(method, path, body, { headers = {}, raw = false, csrf = true } = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (method !== 'GET' && csrf) h['x-delo-request'] = '1';
      let payload;
      if (body !== undefined) {
        if (raw) payload = body;
        else { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
      }
      const r = await fetch(stack.base + path, { method, headers: h, body: payload, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) {
        const v = set.split(';')[0];
        cookie = v.endsWith('=') ? '' : v;
      }
      let json = null;
      const text = await r.text();
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: r.status, body: json, headers: r.headers };
    },
  };
  return c;
}

// Сообщение моста CRM → Платформа, подписанное ключом моста (как это будет делать БЕРТЕЛ CRM).
let bridgeSeq = 0;
export async function bridge(stack, kind, data, { id = `msg-${process.pid}-${++bridgeSeq}`, time = Math.floor(Date.now() / 1000), secret = BRIDGE_SECRET, signature } = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const h = { 'content-type': 'application/json', 'x-bridge-id': id, 'x-bridge-time': String(time) };
  h['x-bridge-signature'] = signature ?? signBridge(secret, id, String(time), Buffer.from(body));
  const r = await fetch(`${stack.base}/api/bridge/crm/${kind}`, { method: 'POST', headers: h, body });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, id };
}

export function lastCode(stack, phone) {
  const calls = stack.providers.sms.calls.filter((x) => x.method === 'sendCode' && x.args.phone === phone);
  return calls.at(-1)?.args.code;
}

// Разрешить новый код сразу (сдвигаем время прошлых кодов назад) — для тестов, где кодов несколько.
export async function ageCodes(stack, phone, minutes = 2) {
  await stack.sql`update login_codes set created_at = created_at - make_interval(mins => ${minutes}) where phone = ${phone}`;
}

export async function login(stack, phone) {
  const c = client(stack);
  const r1 = await c.req('POST', '/api/auth/code', { phone });
  if (r1.status !== 200) throw new Error(`код не отправлен: ${r1.status} ${JSON.stringify(r1.body)}`);
  const r2 = await c.req('POST', '/api/auth/verify', { phone, code: lastCode(stack, phone) });
  if (r2.status !== 200) throw new Error(`вход не удался: ${r2.status} ${JSON.stringify(r2.body)}`);
  c.user = r2.body.user;
  return c;
}

export async function makeOrg(sql, name) {
  return sql.one`insert into organizations (name) values (${name}) returning *`;
}

export async function addMember(sql, orgId, userId, role) {
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
}

export async function setPlatformRole(sql, userId, role) {
  await sql`update users set platform_role = ${role} where id = ${userId}`;
}

// Цена и оплата заявки (без них дело не предложить исполнителю, задачи 1.6 и 1.6а) — напрямую в базе, если ещё нет:
// успешный платёж поддельной ЮKassa и отметка об оплате.
export async function ensurePaid(sql, orderId, kop = 1_500_000) {
  const [o] = await sql`update orders set price_kop = coalesce(price_kop, ${kop}) where id = ${orderId} returning *`;
  if (o.paid_at) return;
  const [u] = await sql`select owner_user_id from orders where id = ${orderId}`;
  await sql`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
            values (${orderId}, ${o.price_kop}, 'succeeded', ${`pay_test_${orderId}`}, ${u.owner_user_id}, now())`;
  await sql`update orders set paid_at = now() where id = ${orderId}`;
}

// Сделать человека специалистом с допусками (напрямую в базе — для проверок, не через кабинет администратора).
export async function makeSpecialist(sql, userId, { permits = [['expertise', 'realty']], regions = ['moscow', 'mo'], capacity = 5, validUntil = null } = {}) {
  await sql`insert into specialists (user_id, regions, capacity) values (${userId}, ${regions}, ${capacity})`;
  for (const [module, service] of permits) {
    await sql`insert into specialist_permits (user_id, module, service, valid_until) values (${userId}, ${module}, ${service}, ${validUntil})`;
  }
}

// Подписать УКЭП (поддельной подписью) свои файлы результата перед сдачей на проверку (задача 2.5). Без имени в профиле
// подписать нельзя — тестовому исполнителю без имени оно ставится.
export async function signResults(stack, c, orderId) {
  await stack.sql`update users set full_name = 'Тестовый Эксперт' where id = ${c.user.id} and coalesce(full_name, '') = ''`;
  const docs = await stack.sql`select d.id from documents d left join document_signatures s on s.document_id = d.id
                               where d.order_id = ${orderId} and d.kind = 'result' and d.deleted_at is null
                                 and d.uploaded_by = ${c.user.id} and s.id is null`;
  for (const d of docs) {
    const r = await c.req('POST', `/api/documents/${d.id}/sign`, { confirm: true });
    if (r.status !== 201) throw new Error(`подпись не поставлена: ${r.status} ${JSON.stringify(r.body)}`);
  }
}
