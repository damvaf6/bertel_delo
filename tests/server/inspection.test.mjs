// Дистанционный осмотр (задача 2.3): исполнитель выдаёт владельцу объекта ссылку — без входа, на ограниченное время, только
// по одной заявке; владелец снимает по шагам для вида объекта; у каждого фото — время и геометка; фото — в деле у эксперта.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { shotMeta, looksLikeImage } from '../../src/ops/inspect-ops.mjs';

let S, owner, dispatcher, spec, spec2;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Осмотровая ул., 7', area: '41' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-осмотра')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const GEO = { 'x-lat': '55.7512', 'x-lon': '37.6184', 'x-accuracy': '14.6' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990002301');
  dispatcher = await login(S, '+79990002302');
  spec = await login(S, '+79990002303');
  spec2 = await login(S, '+79990002304');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  await makeSpecialist(S.sql, spec2.user.id);
  await owner.req('PATCH', '/api/me', { full_name: 'Тестов Владелец' });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

async function inWork(title, executor = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: executor.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(executor, o, 'in_work')).status, 200);
  return o;
}

const tokenOf = (path) => path.split('#')[1];
const anon = () => client(S);
const view = (token) => anon().req('GET', '/api/inspect', undefined, { headers: { 'x-inspect-token': token } });
const shoot = (token, stepId, { buf = JPEG, type = 'image/jpeg', headers = {}, csrf = true } = {}) => anon().req('POST', '/api/inspect/photos', buf, {
  raw: true, csrf, headers: { 'x-inspect-token': token, 'content-type': type, 'x-step': stepId, ...headers },
});
const finish = (token) => anon().req('POST', '/api/inspect/finish', {}, { headers: { 'x-inspect-token': token } });

async function issue(o, body = {}) {
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: tokenOf(r.body.path), link: r.body.link, path: r.body.path };
}

test('шаги осмотра — в описании модуля, у каждого вида объекта свои; ошибка в описании — модуль не принимается', () => {
  const reg = createRegistry();
  const ids = (s) => reg.inspectionSteps('expertise', s).map((x) => x.id);
  assert.ok(ids('realty').includes('facade') && ids('realty').includes('rooms') && !ids('realty').includes('car_vin'));
  assert.ok(ids('vehicle').includes('car_vin') && ids('vehicle').includes('car_odometer') && !ids('vehicle').includes('rooms'));
  assert.ok(ids('land').includes('land_borders'));
  assert.ok(ids('goods').includes('goods_defect') && !ids('goods').includes('defects'));
  assert.equal(reg.inspectionSteps('expertise', 'realty').find((x) => x.id === 'meters').optional, true);
  assert.deepEqual(reg.inspectionSteps('expertise', 'nope'), []);
  const { inspection, express, ...none } = structuredClone(expertise);
  assert.ok(inspection.length);
  assert.deepEqual(createRegistry([none]).inspectionSteps('expertise', 'realty'), [], 'без шагов — осмотра нет');
  const bad = (st) => assert.throws(() => validateModule({ ...structuredClone(expertise), inspection: [st] }), /шаг осмотра|шаги осмотра/);
  bad({ id: 'x1', title: 'Шаг', services: ['nope'] });
  bad({ id: 'x1', title: '' });
  bad({ id: 'x1', title: 'Шаг', optional: 'да' });
  bad({ id: 'x1', title: 'Шаг', extra: 1 });
});

test('ссылка: только исполнитель в работе; секрет в базе не хранится; владелец видит услугу и шаги — без имён и адреса', async () => {
  const o = await inWork('Осмотр квартиры Тестова');
  const g = await spec.req('GET', `/api/orders/${o.id}/inspection`);
  assert.equal(g.status, 200);
  assert.equal(g.body.can_issue, true);
  assert.deepEqual(g.body.days, [1, 3, 7]);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/inspection`, { days: 30 })).status, 400);

  const { token, link, path } = await issue(o);
  assert.match(path, /^\/osmotr#[A-Za-z0-9_-]{43}$/);
  const hours = (new Date(link.expires_at) - Date.now()) / 3600_000;
  assert.ok(hours > 71 && hours <= 72, 'по умолчанию — 3 дня');
  const [row] = await S.sql`select * from inspection_links where id = ${link.id}`;
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(token), 'секрет в базе не хранится');
  assert.ok(!JSON.stringify((await spec.req('GET', `/api/orders/${o.id}/inspection`)).body).includes(token), 'и повторно не показывается');

  const v = await view(token);
  assert.equal(v.status, 200);
  assert.equal(v.body.active, true);
  assert.equal(v.body.service, 'Оценка недвижимости');
  assert.ok(v.body.steps.some((s) => s.id === 'facade' && s.photos === 0));
  const text = JSON.stringify(v.body);
  for (const secret of ['Тестова', 'Тестов Владелец', 'Осмотровая', o.id, '+7999']) assert.ok(!text.includes(secret), `владелец не видит «${secret}»`);
});

test('фото: шаг, время и геометка; не снимок, чужой шаг, неверная геометка — отказ; без признака страницы — отказ', async () => {
  const o = await inWork('Осмотр — фото');
  const { token } = await issue(o, { days: 1 });
  const shotAt = new Date(Date.now() - 60_000).toISOString();
  let r = await shoot(token, 'facade', { headers: { ...GEO, 'x-shot-at': shotAt } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { step: 'facade', photos: 1, geo: true });
  r = await shoot(token, 'rooms', { buf: PNG, type: 'image/png' });
  assert.equal(r.status, 201);
  assert.equal(r.body.geo, false, 'без геометки фото принимается, но отмечается');

  assert.equal((await shoot(token, 'facade', { buf: Buffer.from('это не фото, а текст под видом jpeg'), headers: GEO })).status, 400);
  assert.equal((await shoot(token, 'facade', { type: 'text/plain' })).status, 400);
  assert.equal((await shoot(token, 'car_vin', { headers: GEO })).status, 400, 'шаг другого вида объекта');
  assert.equal((await shoot(token, 'facade', { headers: { 'x-lat': '255', 'x-lon': '37' } })).status, 400);
  assert.equal((await shoot(token, 'facade', { headers: { 'x-lat': '55.7' } })).status, 400, 'широта без долготы');
  assert.equal((await shoot(token, 'facade', { headers: GEO, csrf: false })).status, 403);
  assert.equal((await shoot(token, 'facade', { buf: Buffer.alloc(0) })).status, 400);

  // У эксперта: фото по шагам, имя файла — шаг и номер, время получения, время съёмки и геометка.
  const g = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  const facade = g.steps.find((s) => s.id === 'facade').photos;
  assert.equal(facade.length, 1);
  assert.equal(facade[0].filename, 'Осмотр · Дом снаружи · 1.jpg');
  assert.equal(facade[0].shot_at, shotAt);
  assert.deepEqual(facade[0].geo, { lat: 55.7512, lon: 37.6184, accuracy_m: 15 });
  assert.ok(facade[0].received_at);
  assert.equal(g.steps.find((s) => s.id === 'rooms').photos[0].geo, null);
  assert.equal(g.links[0].photos, 2);
  assert.equal(g.links[0].state, 'active');

  // Фото — документы дела: файл открывается у эксперта; заказчик видит, но удалить не может.
  const docs = (await owner.req('GET', `/api/orders/${o.id}/documents`)).body.documents.filter((d) => d.kind === 'inspection');
  assert.equal(docs.length, 2);
  const link = await spec.req('GET', `/api/documents/${facade[0].document_id}/link`);
  assert.equal(link.status, 200);
  const file = await fetch(S.base + link.body.url);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), JPEG);
  assert.equal((await owner.req('DELETE', `/api/documents/${facade[0].document_id}`)).status, 409);
  // Кто прислал — в журнале без человека (владелец не входил), с шагом и признаком геометки.
  const [a] = await S.sql`select * from audit_log where action = 'inspect.photo' and subject_id = ${o.id} order by id limit 1`;
  assert.equal(a.actor_id, null);
  assert.equal(a.details.geo, true);
});

test('время съёмки: часы телефона дальше суток от сервера не записываются', () => {
  const get = (h) => (k) => h[k];
  assert.equal(shotMeta(get({ 'x-shot-at': '2001-01-01T00:00:00Z' })).shotAt, null);
  assert.equal(shotMeta(get({ 'x-shot-at': 'вчера' })).shotAt, null);
  assert.deepEqual(shotMeta(get({ 'x-lat': '55', 'x-lon': '37' })), { lat: 55, lon: 37, accuracy: null, shotAt: null });
  assert.equal(shotMeta(get({ 'x-accuracy': '10' })).accuracy, null, 'точность без места не нужна');
  assert.throws(() => shotMeta(get({ 'x-lat': 'abc', 'x-lon': '37' })));
  assert.ok(looksLikeImage(JPEG, 'image/jpeg') && looksLikeImage(PNG, 'image/png') && !looksLikeImage(PNG, 'image/jpeg'));
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(8)]);
  assert.ok(looksLikeImage(heic, 'image/heic'));
});

test('«Готово»: ссылка закрывается, исполнитель получает уведомление; дальше фото не принимаются', async () => {
  const o = await inWork('Осмотр — готово');
  const { token } = await issue(o);
  assert.equal((await finish(token)).status, 409, 'без фото завершить нельзя');
  assert.equal((await shoot(token, 'kitchen', { headers: GEO })).status, 201);
  const r = await finish(token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { finished: true, photos: 1 });
  const [n] = await S.sql`select * from notifications where user_id = ${spec.user.id} and event = 'inspection_done' and order_id = ${o.id}`;
  assert.ok(n, 'исполнитель получил уведомление');
  const sms = await S.sql`select body from notification_deliveries where notification_id = ${n.id}`;
  assert.equal(sms.length, 1);
  assert.ok(!sms[0].body.includes('Осмотр — готово'), 'в СМС нет названия заявки');
  assert.equal((await shoot(token, 'kitchen', { headers: GEO })).status, 410);
  assert.equal((await finish(token)).status, 410);
  const v = await view(token);
  assert.equal(v.body.active, false);
  assert.match(v.body.message, /завершён/);
  assert.equal(v.body.steps, undefined, 'после завершения шаги не показываются');
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.links[0].state, 'finished');
});

test('ссылка перестаёт действовать: новая ссылка, отзыв, истёк срок, дело ушло из работы или к другому исполнителю', async () => {
  const o = await inWork('Осмотр — сроки');
  const first = await issue(o);
  const second = await issue(o, { days: 7 });
  assert.equal((await view(first.token)).body.active, false, 'новая ссылка отзывает прежнюю');
  assert.equal((await view(second.token)).body.active, true);
  // Отзыв — только ссылки этой заявки.
  const other = await inWork('Осмотр — другая заявка');
  assert.equal((await spec.req('DELETE', `/api/orders/${other.id}/inspection/${second.link.id}`)).status, 404);
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/inspection/abc`)).status, 404);
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/inspection/${second.link.id}`)).status, 204);
  assert.equal((await view(second.token)).body.active, false);
  assert.equal((await shoot(second.token, 'facade')).status, 410);

  const third = await issue(o);
  await S.sql`update inspection_links set expires_at = now() - interval '1 minute' where id = ${third.link.id}`;
  const v = await view(third.token);
  assert.equal(v.body.active, false);
  assert.match(v.body.message, /истёк/);

  // Дело сдано на проверку — ссылка закрыта; вернули на доработку — снова действует, пока не истекла.
  const fourth = await issue(o);
  assert.equal((await shoot(fourth.token, 'facade', { headers: GEO })).status, 201);
  const res = await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('заключение'), { raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': 'z.txt' } });
  assert.equal(res.status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200, 'сдано на проверку');
  assert.equal((await view(fourth.token)).body.active, false);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/inspection`, {})).status, 403, 'на проверке ссылку не выдать');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'review', reason: 'Нужно доснять кухню' })).status, 200);
  assert.equal((await view(fourth.token)).body.active, true);

  // Дело передали другому исполнителю — ссылка прежнего не действует, а фото остаются в деле.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'in_work', reason: 'Передача' })).status, 200);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec2.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec2, o, 'in_work')).status, 200);
  assert.equal((await view(fourth.token)).body.active, false);
  const g = (await spec2.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.equal(g.can_issue, true);
  assert.equal(g.steps.find((s) => s.id === 'facade').photos.length, 1);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/inspection`)).status, 404, 'прежний исполнитель дела больше не видит');
});

test('лимит фото на шаг; черновик заключения видит фото осмотра по именам шагов', async () => {
  const o = await inWork('Осмотр — лимит');
  const { token } = await issue(o);
  for (let i = 0; i < 12; i++) assert.equal((await shoot(token, 'kitchen', { headers: GEO })).status, 201);
  const r = await shoot(token, 'kitchen', { headers: GEO });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /не больше 12/);
  assert.equal((await shoot(token, 'bathroom', { headers: GEO })).status, 201, 'другой шаг — можно');

  S.providers.ai.reset();
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: null })).status, 201);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('Осмотр · Кухня · 1.jpg') && prompt.includes('Осмотр · Санузел и ванная · 1.jpg'));
});

test('геометка разрешена только странице осмотра', async () => {
  const page = await fetch(`${S.base}/osmotr`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(self)');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const home = await fetch(`${S.base}/`);
  assert.equal(home.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
});
