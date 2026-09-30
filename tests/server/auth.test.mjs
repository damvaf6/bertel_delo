// Вход по коду: исправления Б-1, Б-9, Б-11, Б-14, Б-15 из AUDIT.md закрыты тестами.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, login, lastCode, ageCodes } from '../helpers.mjs';
import { normPhone, LIMITS } from '../../src/auth/auth.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('номер телефона приводится к виду +7XXXXXXXXXX', () => {
  assert.equal(normPhone('8 (999) 000-00-01'), '+79990000001');
  assert.equal(normPhone('+7 999 000 00 01'), '+79990000001');
  assert.equal(normPhone('79990000001'), '+79990000001');
  assert.equal(normPhone('9990000001'), '+79990000001');
  for (const bad of ['', '123', '+1 999 000 00 01', '84951234567', null, '8999000000011']) assert.equal(normPhone(bad), null, String(bad));
});

test('код случайный, 6 цифр, в базе только хэш; первый вход создаёт пользователя', async () => {
  const phone = '+79990000101';
  const c = client(S);
  const r = await c.req('POST', '/api/auth/code', { phone: '8 999 000-01-01' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: true, ttl_sec: 300, channel: 'sms' });
  const code = lastCode(S, phone);
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(r.body).includes(code), 'код не приходит в ответе');
  const rows = await S.sql`select code_hash from login_codes where phone = ${phone}`;
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].code_hash.includes(code));

  const v = await c.req('POST', '/api/auth/verify', { phone, code });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.phone, phone);
  assert.equal(v.body.user.platform_role, null, 'новый пользователь — без служебной роли');
  assert.equal((await c.req('GET', '/api/me')).status, 200);

  // Код одноразовый.
  const again = await client(S).req('POST', '/api/auth/verify', { phone, code });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, 'code_expired');
});

test('сессия — в cookie HttpOnly, SameSite=Strict; токен не в ответе и не в базе', async () => {
  const phone = '+79990000102';
  const c = client(S);
  await c.req('POST', '/api/auth/code', { phone });
  const r = await c.req('POST', '/api/auth/verify', { phone, code: lastCode(S, phone) });
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^delo_sid=[\w-]{40,};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const token = cookie.split(';')[0].split('=')[1];
  assert.ok(!JSON.stringify(r.body).includes(token));
  const [{ n }] = await S.sql`select count(*)::int as n from sessions where token_hash = ${token}`;
  assert.equal(n, 0, 'в базе хранится хэш, не токен');
});

test('в боевом режиме cookie с флагом Secure', async () => {
  const { sessionCookie } = await import('../../src/http/core.mjs');
  assert.match(sessionCookie({ cookieSecure: true }, 't', 10), /; Secure$/);
});

test('ошибки входа — коды 4xx с понятным текстом, без подробностей сервера', async () => {
  const c = client(S);
  const bad = await c.req('POST', '/api/auth/code', { phone: '12345' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_phone');
  const none = await c.req('POST', '/api/auth/verify', { phone: '+79990000103', code: '123456' });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'code_expired');
});

test('новый код — не чаще раза в минуту и не больше 5 в час', async () => {
  const phone = '+79990000104';
  const c = client(S);
  assert.equal((await c.req('POST', '/api/auth/code', { phone })).status, 200);
  const soon = await c.req('POST', '/api/auth/code', { phone });
  assert.equal(soon.status, 429);
  assert.equal(soon.body.error, 'resend_too_soon');
  for (let i = 1; i < LIMITS.codesPerHour; i++) {
    await ageCodes(S, phone, 2);
    assert.equal((await c.req('POST', '/api/auth/code', { phone })).status, 200);
  }
  await ageCodes(S, phone, 2);
  const many = await c.req('POST', '/api/auth/code', { phone });
  assert.equal(many.status, 429);
  assert.equal(many.body.error, 'too_many_codes');
});

test('5 неверных вводов сжигают код; новый код не обнуляет счёт — 10 ошибок в час закрывают вход (Б-14)', async () => {
  const phone = '+79990000105';
  const c = client(S);
  await c.req('POST', '/api/auth/code', { phone });
  const good = lastCode(S, phone);
  const wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < LIMITS.attemptsPerCode; i++) {
    const r = await c.req('POST', '/api/auth/verify', { phone, code: wrong });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'wrong_code');
  }
  const burned = await c.req('POST', '/api/auth/verify', { phone, code: good });
  assert.equal(burned.status, 429, 'после 5 ошибок верный код уже не принимается');

  await ageCodes(S, phone, 2);
  await c.req('POST', '/api/auth/code', { phone });
  const good2 = lastCode(S, phone);
  const wrong2 = good2 === '000000' ? '111111' : '000000';
  for (let i = 0; i < LIMITS.failuresPerHour - LIMITS.attemptsPerCode; i++) await c.req('POST', '/api/auth/verify', { phone, code: wrong2 });
  const locked = await c.req('POST', '/api/auth/verify', { phone, code: good2 });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'too_many_attempts');
});

test('отключённый пользователь не входит, его сессии перестают работать (Б-15)', async () => {
  const phone = '+79990000106';
  const c = await login(S, phone);
  await S.sql`update users set is_active = false where phone = ${phone}`;
  assert.equal((await c.req('GET', '/api/me')).status, 401);
  await ageCodes(S, phone, 2);
  const c2 = client(S);
  await c2.req('POST', '/api/auth/code', { phone });
  const r = await c2.req('POST', '/api/auth/verify', { phone, code: lastCode(S, phone) });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'blocked');
  assert.equal(c2.cookie, '');
});

test('СМС-поставщик отказал — 503, код не остаётся действующим', async () => {
  const phone = '+79990000107';
  S.providers.sms.script({ kind: 'fail', message: 'нет связи' });
  try {
    const r = await client(S).req('POST', '/api/auth/code', { phone });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'sms_unavailable');
    assert.ok(!JSON.stringify(r.body).includes('нет связи'), 'текст ошибки поставщика наружу не уходит');
  } finally {
    S.providers.sms.script({ kind: 'ok' });
  }
  const [{ n }] = await S.sql`select count(*)::int as n from login_codes where phone = ${phone} and expires_at > now()`;
  assert.equal(n, 0);
});

test('СМС-поставщик медлит — вход всё равно проходит', async () => {
  const phone = '+79990000108';
  S.providers.sms.script({ kind: 'delay', ms: 200 });
  try {
    const t = Date.now();
    const c = await login(S, phone);
    assert.ok(Date.now() - t >= 200);
    assert.equal(c.user.phone, phone);
  } finally {
    S.providers.sms.script({ kind: 'ok' });
  }
});

test('звонок: робот называет тот же 6-значный код; СМС при этом не уходит', async () => {
  const phone = '+79990000109';
  const c = client(S);
  const smsBefore = S.providers.sms.calls.length;
  const r = await c.req('POST', '/api/auth/code', { phone, channel: 'call' });
  assert.equal(r.status, 200);
  assert.equal(r.body.channel, 'call');
  assert.equal(S.providers.sms.calls.length, smsBefore);
  const code = S.providers.call.calls.filter((x) => x.args.phone === phone).at(-1).args.code;
  assert.match(code, /^\d{6}$/);
  const [row] = await S.sql`select channel from login_codes where phone = ${phone}`;
  assert.equal(row.channel, 'call');
  assert.equal((await c.req('POST', '/api/auth/verify', { phone, code })).status, 200);
});

test('звонок и СМС — общие лимиты: сразу после СМС позвонить нельзя, через минуту можно', async () => {
  const phone = '+79990000110';
  const c = client(S);
  assert.equal((await c.req('POST', '/api/auth/code', { phone })).status, 200);
  const soon = await c.req('POST', '/api/auth/code', { phone, channel: 'call' });
  assert.equal(soon.status, 429);
  assert.equal(soon.body.error, 'resend_too_soon');
  await ageCodes(S, phone, 2);
  assert.equal((await c.req('POST', '/api/auth/code', { phone, channel: 'call' })).status, 200);
  assert.equal((await c.req('POST', '/api/auth/code', { phone: '+79990000111', channel: 'pigeon' })).status, 400);
});

test('звонок не удался — 503, код не остаётся действующим', async () => {
  const phone = '+79990000112';
  S.providers.call.script({ kind: 'fail', message: 'линия занята' });
  try {
    const r = await client(S).req('POST', '/api/auth/code', { phone, channel: 'call' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'call_unavailable');
  } finally {
    S.providers.call.script({ kind: 'ok' });
  }
  const [{ n }] = await S.sql`select count(*)::int as n from login_codes where phone = ${phone} and expires_at > now()`;
  assert.equal(n, 0);
});
