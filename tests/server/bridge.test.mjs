// Мост CRM → Платформа (задача 1.10): подпись сообщений, перенос профиля с согласием, предложения госзаказа без данных дела,
// число дел в CRM для подбора. Только в одну сторону; что видит исполнитель и кто ещё.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, bridge, setPlatformRole, ageCodes, BRIDGE_SECRET } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { looksLikeCaseData } from '../../src/bridge/crm.mjs';
import { loadConfig, ConfigError } from '../../src/config.mjs';

let S;
const today = todayMsk();
const consent = { platform: true, version: 'crm-2026-10', given_at: '2026-09-15T10:00:00Z' };
const profile = (n, extra = {}) => ({
  crm_id: `crm-${n}`, phone: `+7999000${String(n).padStart(4, '0')}`, email: `perevodchik-${n}@example.test`,
  full_name: `Тестовый переводчик ${n}`, languages: ['китайский', 'английский'], qualification: 'Переводчик, диплом МГЛУ', consent, ...extra,
});
const offer = (n, crmId, extra = {}) => ({
  offer_id: `offer-${n}`, crm_id: crmId, customer: 'ГСУ СК России по г. Москве', language: 'китайский → русский',
  deadline: addDays(today, 5), volume: { amount: 12, unit: 'pages' }, payment: 'pp1240', status: 'open', ...extra,
});

before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('подпись: без подписи, с чужим ключом, старое или исправленное в пути сообщение — «не найдено»; людям мост недоступен', async () => {
  const data = { loads: [{ crm_id: 'crm-x', open_cases: 1 }] };
  assert.equal((await bridge(S, 'load', data)).status, 200);
  assert.equal((await bridge(S, 'load', data, { signature: '' })).status, 404);
  assert.equal((await bridge(S, 'load', data, { secret: 'чужой-ключ-0123456789-0123456789-0123' })).status, 404);
  assert.equal((await bridge(S, 'load', data, { time: Math.floor(Date.now() / 1000) - 600 })).status, 404, 'старше 5 минут');
  assert.equal((await bridge(S, 'load', data, { time: Math.floor(Date.now() / 1000) + 600 })).status, 404, 'из будущего');
  assert.equal((await bridge(S, 'load', data, { id: 'bad id' })).status, 404);
  // Подпись от одного содержимого к другому не подходит.
  const ok = await bridge(S, 'load', data, { id: 'sig-1' });
  const { signBridge } = await import('../../src/bridge/signature.mjs');
  const time = String(Math.floor(Date.now() / 1000));
  const sig = signBridge(BRIDGE_SECRET, 'sig-2', time, Buffer.from(JSON.stringify(data)));
  const tampered = await fetch(`${S.base}/api/bridge/crm/load`, {
    method: 'POST', body: JSON.stringify({ loads: [{ crm_id: 'crm-x', open_cases: 99 }] }),
    headers: { 'content-type': 'application/json', 'x-bridge-id': 'sig-2', 'x-bridge-time': time, 'x-bridge-signature': sig },
  });
  assert.equal(ok.status, 200);
  assert.equal(tampered.status, 404);
  // Вошедший человек (даже администратор) с cookie и признаком страницы мост не вызовет.
  const admin = await login(S, '+79990001001');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  assert.equal((await admin.req('POST', '/api/bridge/crm/load', data)).status, 404);
  assert.equal((await client(S).req('POST', '/api/bridge/crm/profiles', { profiles: [profile(1)] })).status, 404);
});

test('мост выключен без ключа: операций нет; короткий ключ и CRM_URL без https на боевом — сервер не стартует', async () => {
  const off = await startApp({ CRM_BRIDGE_SECRET: '' });
  try {
    assert.equal(off.app.locals.ops.filter((o) => o.auth === 'bridge').length, 0);
    assert.equal((await bridge(off, 'load', { loads: [{ crm_id: 'a', open_cases: 1 }] })).status, 404);
  } finally { await off.close(); }
  const base = { DATABASE_URL: 'postgres://x@localhost/x', DB_SSL: 'disable', COOKIE_SECURE: '0' };
  assert.throws(() => loadConfig({ ...base, CRM_BRIDGE_SECRET: 'короткий' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, APP_ENV: 'stage', DB_SSL: 'verify', COOKIE_SECURE: '1', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', CRM_URL: 'http://crm.example.test' }), ConfigError);
});

test('перенос профилей: с согласием — учётная запись и профиль исполнителя без допусков; без согласия и с лишними полями — нет', async () => {
  const existing = await login(S, '+79990000102'); // уже входил в Платформу — связывается, а не создаётся заново
  const r = await bridge(S, 'profiles', { profiles: [
    profile(101),
    profile(102),
    profile(103, { consent: { ...consent, platform: false } }),
    profile(104, { consent: undefined }),
    profile(105, { case_number: '1-234/2026' }),
    profile(106, { phone: '12345' }),
    profile(107, { email: 'perevodchik-101@example.test' }),
    profile(101, { crm_id: 'crm-dup' }),
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const out = Object.fromEntries(r.body.results.map((x, i) => [i, x]));
  assert.equal(out[0].outcome, 'created');
  assert.equal(out[1].outcome, 'linked');
  assert.match(out[2].reason, /Платформа/);
  assert.match(out[3].reason, /consent/);
  assert.match(out[4].reason, /лишние поля: case_number/);
  assert.match(out[5].reason, /phone/);
  assert.match(out[6].reason, /повтор/);
  assert.match(out[7].reason, /повтор/);
  assert.deepEqual(r.body.counts, { created: 1, linked: 1, rejected: 6 });
  // В ответе и журнале нет телефонов и почты.
  assert.doesNotMatch(JSON.stringify(r.body), /\+7999|@example/);
  const [log] = await S.sql`select details from audit_log where action = 'crm.bridge.profiles' order by id desc limit 1`;
  assert.doesNotMatch(JSON.stringify(log.details), /\+7999|@example/);

  const u = await S.sql.one`select u.full_name, u.platform_role, s.active, (select count(*)::int from specialist_permits p where p.user_id = u.id) as permits
                            from users u join specialists s on s.user_id = u.id where u.phone = '+79990000101'`;
  assert.deepEqual(u, { full_name: 'Тестовый переводчик 101', platform_role: null, active: true, permits: 0 });
  // Отклонённые не созданы.
  assert.equal((await S.sql`select 1 from users where phone in ('+79990000103', '+79990000104', '+79990000105')`).length, 0);

  // Вошёл по своему телефону — видит перенесённый профиль исполнителя; на услуги Платформы — только через допуск администратора.
  const p = await login(S, '+79990000101');
  const me = (await p.req('GET', '/api/specialist/me')).body.specialist;
  assert.deepEqual(me.crm, { languages: ['китайский', 'английский'], qualification: 'Переводчик, диплом МГЛУ' });
  assert.deepEqual(me.permits, []);
  const ex = (await existing.req('GET', '/api/specialist/crm')).body.crm;
  assert.equal(ex.linked, true);
  // Имя, которое человек уже указал сам, не перезаписывается.
  await existing.req('PATCH', '/api/me', { full_name: 'Своё имя' });
  await bridge(S, 'profiles', { profiles: [profile(102, { full_name: 'Имя из CRM' })] });
  assert.equal((await existing.req('GET', '/api/me')).body.user.full_name, 'Своё имя');
});

test('повтор переноса: обновляет языки; сменившийся телефон и телефон, связанный с другим профилем, — не принимаются; повтор сообщения — прежний итог', async () => {
  const again = await bridge(S, 'profiles', { profiles: [profile(101, { languages: ['китайский'] })] }, { id: 'prof-again' });
  assert.deepEqual(again.body.counts, { updated: 1 });
  const dup = await bridge(S, 'profiles', { profiles: [profile(101, { languages: ['немецкий'] })] }, { id: 'prof-again' });
  assert.equal(dup.body.duplicate, true);
  assert.deepEqual(dup.body.counts, { updated: 1 });
  assert.deepEqual((await S.sql.one`select languages from crm_profiles where crm_id = 'crm-101'`).languages, ['китайский'], 'повтор не обработан второй раз');
  // Номер сообщения другого вида — отказ.
  assert.equal((await bridge(S, 'load', { loads: [{ crm_id: 'crm-101', open_cases: 1 }] }, { id: 'prof-again' })).status, 409);

  const moved = await bridge(S, 'profiles', { profiles: [profile(101, { phone: '+79990000199' })] });
  assert.match(moved.body.results[0].reason, /телефон отличается/);
  const mail = await bridge(S, 'profiles', { profiles: [profile(108, { email: 'perevodchik-101@example.test' })] });
  assert.match(mail.body.results[0].reason, /почта уже у другого/);
  const taken = await bridge(S, 'profiles', { profiles: [profile(102, { crm_id: 'crm-other' })] });
  assert.match(taken.body.results[0].reason, /уже связан с другим/);
  assert.equal((await S.sql.one`select phone from users u join crm_profiles c on c.user_id = u.id where c.crm_id = 'crm-101'`).phone, '+79990000101');
});

test('загрузка: число дел в CRM идёт в «дела вне платформы» и снижает оценку загрузки в подборе', async () => {
  // Специалист Платформы, перенесённый из CRM, с допуском на оценку недвижимости.
  await bridge(S, 'profiles', { profiles: [profile(111), profile(112)] });
  const ids = Object.fromEntries((await S.sql`select c.crm_id, c.user_id from crm_profiles c where crm_id in ('crm-111', 'crm-112')`).map((x) => [x.crm_id, x.user_id]));
  for (const id of Object.values(ids)) await S.sql`insert into specialist_permits (user_id, module, service) values (${id}, 'expertise', 'realty')`;

  const r = await bridge(S, 'load', { loads: [
    { crm_id: 'crm-111', open_cases: 4 }, { crm_id: 'crm-112', open_cases: 0 }, { crm_id: 'crm-нет', open_cases: 1 },
    { crm_id: 'crm-nobody', open_cases: 2 }, { crm_id: 'crm-111', open_cases: 600 }, { crm_id: 'crm-112', open_cases: 1, name: 'Иванов' },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.outcome), ['updated', 'updated', 'rejected', 'unknown', 'rejected', 'rejected']);
  assert.equal((await S.sql.one`select external_load from specialists where user_id = ${ids['crm-111']}`).external_load, 4);

  const owner = await login(S, '+79990001101');
  const dispatcher = await login(S, '+79990001102');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 20), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'тестовый адрес, 1' } });
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  const c = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  const busy = c.find((x) => x.user_id === ids['crm-111']);
  const free = c.find((x) => x.user_id === ids['crm-112']);
  assert.ok(busy.score.features.load.score < free.score.features.load.score, JSON.stringify(c));
  assert.ok(busy.score.total < free.score.total);
});

test('предложения госзаказа: только госзаказчик, язык, срок, объём, ПП № 1240; с номером дела или фамилией — не принимаются', async () => {
  const r = await bridge(S, 'offers', { offers: [
    offer(1, 'crm-101'),
    offer(2, 'crm-101', { customer: 'СО по ЦАО, дело № 12345' }),
    offer(3, 'crm-101', { customer: 'Следователь Петров И.И.' }),
    offer(4, 'crm-101', { customer: 'ГУ МВД, 1-234/2026' }),
    offer(5, 'crm-101', { case_number: '1-234/2026' }),
    offer(6, 'crm-101', { payment: 'contract' }),
    offer(7, 'crm-101', { deadline: addDays(today, -1) }),
    offer(8, 'crm-101', { volume: { amount: 3, unit: 'pages', note: 'Иванов' } }),
    offer(9, 'crm-101', { language: 'китайский; дело 77' }),
    offer(10, 'crm-nosuch'),
    offer(11, 'crm-102', { volume: { amount: 2000, unit: 'signs' } }),
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => x.outcome),
    ['created', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'unknown', 'created']);
  assert.equal((await S.sql`select 1 from crm_offers`).length, 2);
  // Проверка «похоже на данные дела» — на типичных примерах.
  for (const s of ['№ 1-234/2026', 'дело 12/2026', 'Иванов И.И.', 'И.И. Иванов', 'тел. 89991234567', 'a@b.ru']) assert.ok(looksLikeCaseData(s), s);
  for (const s of ['ГСУ СК России по г. Москве', 'УМВД России по ЮЗАО г. Москвы', 'Мещанский районный суд']) assert.ok(!looksLikeCaseData(s), s);
});

test('кабинет исполнителя: свои предложения и число дел в CRM, ссылка «Открыть в CRM»; уведомление; чужие не видны; закрытое пропадает', async () => {
  for (const phone of ['+79990000101', '+79990000102']) await ageCodes(S, phone);
  const p = await login(S, '+79990000101');
  const other = await login(S, '+79990000102');
  const stranger = await login(S, '+79990001201');
  await bridge(S, 'load', { loads: [{ crm_id: 'crm-101', open_cases: 3 }] });
  const view = (await p.req('GET', '/api/specialist/crm')).body.crm;
  assert.equal(view.linked, true);
  assert.equal(view.open_cases, 3);
  assert.equal(view.offers.length, 1);
  assert.deepEqual(view.offers[0], {
    offer_id: 'offer-1', customer: 'ГСУ СК России по г. Москве', language: 'китайский → русский', deadline: addDays(today, 5),
    volume: '12 стр.', payment: 'Оплата по Положению (ПП РФ № 1240)', url: 'https://crm.example.test/offers/offer-1',
  });
  // Чужое предложение (у другого исполнителя) не видно; посторонний не связан с CRM.
  assert.deepEqual((await other.req('GET', '/api/specialist/crm')).body.crm.offers.map((o) => o.offer_id), ['offer-11']);
  assert.deepEqual((await stranger.req('GET', '/api/specialist/crm')).body.crm, { linked: false, offers: [] });

  // Уведомление о новом предложении — в кабинете (ведёт в раздел «Специалист») и СМС без подробностей.
  const n = (await p.req('GET', '/api/notifications')).body.notifications.find((x) => x.event === 'crm_offer' || /госзаказа/.test(x.title));
  assert.ok(n, 'уведомление есть');
  assert.equal(n.section, 'specialist');
  const sms = await S.sql`select body from notification_deliveries d join notifications x on x.id = d.notification_id
                          where x.event = 'crm_offer' and d.phone = '+79990000101'`;
  assert.equal(sms.length, 1);
  assert.doesNotMatch(sms[0].body, /ГСУ|китайск/);

  // Обновление того же предложения — без второго уведомления; закрытие — пропадает из списка.
  await bridge(S, 'offers', { offers: [offer(1, 'crm-101', { volume: { amount: 14, unit: 'pages' } })] });
  assert.equal((await S.sql`select 1 from notifications where event = 'crm_offer' and user_id = ${p.user.id}`).length, 1);
  assert.equal((await p.req('GET', '/api/specialist/crm')).body.crm.offers[0].volume, '14 стр.');
  const closed = await bridge(S, 'offers', { offers: [{ offer_id: 'offer-1', crm_id: 'crm-101', status: 'closed' }, { offer_id: 'offer-x', crm_id: 'crm-101', status: 'closed' }] });
  assert.deepEqual(closed.body.results.map((x) => x.outcome), ['closed', 'unknown']);
  assert.deepEqual((await p.req('GET', '/api/specialist/crm')).body.crm.offers, []);
  // Предложение того же номера другому исполнителю закрытием первому не задето.
  assert.equal((await other.req('GET', '/api/specialist/crm')).body.crm.offers.length, 1);
});

test('мост только принимает: в CRM Платформа ничего не отправляет; профиль из CRM не даёт служебных ролей и чужих дел', async () => {
  const p = await login(S, '+79990000111');
  const owner = await login(S, '+79990001301');
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  assert.equal((await p.req('GET', `/api/orders/${o.id}`)).status, 404);
  assert.equal((await p.req('GET', '/api/specialists')).status, 404);
  // Сообщение без нужного поля или с лишним верхним полем — целиком отклоняется.
  assert.equal((await bridge(S, 'offers', { offers: [], extra: 1 })).status, 400);
  assert.equal((await bridge(S, 'load', { loads: [] })).status, 400);
  assert.equal((await bridge(S, 'profiles', 'не JSON')).status, 400);
});

test('реестр: операция моста — только /api/bridge/…, с подписью исходного текста, без проверки доступа людей', async () => {
  const { validateOp } = await import('../../src/http/router.mjs');
  const h = async () => {};
  assert.doesNotThrow(() => validateOp({ id: 'b', method: 'POST', path: '/api/bridge/crm/x', auth: 'bridge', body: 'raw', handler: h }));
  assert.throws(() => validateOp({ id: 'b', method: 'POST', path: '/api/bridge/crm/x', auth: 'bridge', handler: h }), /подписью/);
  assert.throws(() => validateOp({ id: 'b', method: 'POST', path: '/api/orders/x', auth: 'bridge', body: 'raw', handler: h }), /подписью/);
  assert.throws(() => validateOp({ id: 'b', method: 'POST', path: '/api/bridge/crm/x', auth: 'bridge', body: 'raw', access: 'self', handler: h }), /нет проверки/);
  assert.throws(() => validateOp({ id: 'b', method: 'POST', path: '/api/bridge/crm/x', auth: 'bridge', body: 'raw', csrf: false, handler: h }), /нет проверки/);
});
