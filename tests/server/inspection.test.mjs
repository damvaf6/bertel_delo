// Дистанционный осмотр (задача 2.3): исполнитель выдаёт владельцу объекта ссылку — без входа, на ограниченное время, только
// по одной заявке; владелец снимает по шагам для вида объекта; у каждого фото — время и геометка; фото — в деле у эксперта.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { shotMeta, looksLikeImage, remindSilentInspections } from '../../src/ops/inspect-ops.mjs';

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

test('2.20: ссылка владельцу СМС с платформы — номер не хранится, секрета нет в базе; не ушла — ссылка всё равно выдана', async () => {
  const o = await inWork('Осмотр — СМС владельцу');
  const sms = S.providers.sms;
  const before = sms.calls.length;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/inspection`, { phone: '12345' })).status, 400, 'неверный номер');
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, { days: 1, phone: '8 (999) 000-23-99' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sms, 'sent');
  assert.equal(r.body.link.sms_to, '+7 *** ***-23-99');
  const call = sms.calls.at(-1);
  assert.equal(sms.calls.length, before + 1);
  assert.equal(call.method, 'send');
  assert.equal(call.args.phone, '+79990002399');
  const token = tokenOf(r.body.path);
  assert.ok(call.args.text.endsWith(`/osmotr#${token}`), call.args.text);
  assert.ok(!call.args.text.includes('СМС владельцу'), 'в СМС нет названия заявки');
  // Ни номера, ни секрета — ни в ссылке, ни в очереди СМС, ни в журнале.
  const dump = JSON.stringify([
    await S.sql`select * from inspection_links where order_id = ${o.id}`,
    await S.sql`select * from notification_deliveries where body like ${'%' + token + '%'} or phone = '+79990002399'`,
    await S.sql`select * from audit_log where subject_id = ${o.id}`,
  ]);
  assert.ok(!dump.includes(token) && !dump.includes('9990002399'), 'номер и секрет не сохранены');
  const g = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.equal(g.links[0].sms_to, '+7 *** ***-23-99');
  assert.ok(g.links[0].sms_sent_at);
  for (const u of [owner, dispatcher]) {
    const v = (await u.req('GET', `/api/orders/${o.id}/inspection`)).body;
    assert.equal(v.links[0].sms_to, '+7 *** ***-23-99', 'остальные видят только скрытый номер');
  }

  sms.script({ kind: 'fail', message: 'нет связи' });
  try {
    const f = await spec.req('POST', `/api/orders/${o.id}/inspection`, { phone: '+79990002399' });
    assert.equal(f.status, 201);
    assert.equal(f.body.sms, 'failed');
    assert.equal(f.body.link.sms_to, null);
    assert.equal((await view(tokenOf(f.body.path))).body.active, true, 'ссылка выдана — эксперт отправит сам');
  } finally { sms.script({ kind: 'ok' }); }
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/inspection`, {})).body.sms, null, 'без номера СМС не шлётся');
});

test('2.20: не больше 5 СМС со ссылкой по заявке в сутки; без номера ссылку выдать можно', async () => {
  const o = await inWork('Осмотр — лимит СМС');
  for (let i = 0; i < 5; i += 1) assert.equal((await spec.req('POST', `/api/orders/${o.id}/inspection`, { phone: '+79990002398' })).body.sms, 'sent');
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, { phone: '+79990002398' });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'sms_limit');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/inspection`, {})).status, 201);
});

test('2.20: попросить переснять шаг — владелец видит просьбу у шага; новое фото шага её закрывает; отменить может эксперт', async () => {
  const o = await inWork('Осмотр — переснять');
  const first = await issue(o);
  assert.equal((await shoot(first.token, 'facade', { headers: GEO })).status, 201);
  assert.equal((await finish(first.token)).status, 200);
  const ask = (body, who = spec) => who.req('POST', `/api/orders/${o.id}/inspection/retakes`, body);
  assert.equal((await ask({ step: 'nope', note: 'x' })).status, 400);
  assert.equal((await ask({ step: 'facade', note: '' })).status, 400);
  assert.equal((await ask({ step: 'facade', note: 'x'.repeat(301) })).status, 400);
  for (const u of [owner, dispatcher]) assert.equal((await ask({ step: 'facade', note: 'Размыто' }, u)).status, 403);
  assert.equal((await ask({ step: 'facade', note: 'Размыто' }, spec2)).status, 404, 'посторонний эксперт');
  let r = await ask({ step: 'facade', note: 'Размыто' });
  assert.equal(r.status, 201);
  assert.equal(r.body.active_link, false, 'прежняя ссылка завершена — нужна новая');
  r = await ask({ step: 'facade', note: 'Фасад целиком, днём' });
  assert.equal(r.body.retake.note, 'Фасад целиком, днём', 'повторная просьба заменяет текст');
  assert.equal((await S.sql`select count(*)::int as n from inspection_retakes where order_id = ${o.id}`)[0].n, 1);
  const g = (await owner.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.equal(g.steps.find((s) => s.id === 'facade').retake.note, 'Фасад целиком, днём', 'видит каждый, кто видит заявку');
  assert.equal(g.steps.find((s) => s.id === 'rooms').retake, null);

  // Новая ссылка с СМС: текст — про пересъёмку; владелец видит просьбу у шага.
  const n = await spec.req('POST', `/api/orders/${o.id}/inspection`, { phone: '+79990002397' });
  assert.match(S.providers.sms.calls.at(-1).args.text, /переснять/);
  const token = tokenOf(n.body.path);
  let v = (await view(token)).body;
  assert.equal(v.steps.find((s) => s.id === 'facade').retake, 'Фасад целиком, днём');
  assert.equal(v.steps.find((s) => s.id === 'rooms').retake, null);
  assert.equal((await ask({ step: 'rooms', note: 'Нет кухни' })).body.active_link, true);
  assert.equal((await shoot(token, 'facade', { headers: GEO })).status, 201);
  v = (await view(token)).body;
  assert.equal(v.steps.find((s) => s.id === 'facade').retake, null, 'новое фото закрыло просьбу');
  const names = await S.sql`select d.filename from inspection_photos p join documents d on d.id = p.document_id
                            where d.order_id = ${o.id} and p.step = 'facade' order by d.created_at`;
  assert.deepEqual(names.map((x) => x.filename), ['Осмотр · Дом снаружи · 1.jpg', 'Осмотр · Дом снаружи · 2.jpg'], 'номер — по всей заявке');
  assert.equal(v.steps.find((s) => s.id === 'rooms').retake, 'Нет кухни');
  const [closed] = await S.sql`select closed_reason from inspection_retakes where order_id = ${o.id} and step = 'facade'`;
  assert.equal(closed.closed_reason, 'photo');

  const id = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.steps.find((s) => s.id === 'rooms').retake.id;
  assert.equal((await owner.req('DELETE', `/api/orders/${o.id}/inspection/retakes/${id}`)).status, 403);
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/inspection/retakes/x`)).status, 404);
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/inspection/retakes/${id}`)).status, 204);
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/inspection/retakes/${id}`)).status, 404, 'уже отменена');
  assert.equal((await view(token)).body.steps.find((s) => s.id === 'rooms').retake, null);
  // Чужая заявка: просьбу по номеру из другой заявки не отменить.
  const other = await inWork('Осмотр — чужая просьба');
  const x = (await spec.req('POST', `/api/orders/${other.id}/inspection/retakes`, { step: 'facade', note: 'Тёмно' })).body.retake.id;
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/inspection/retakes/${x}`)).status, 404);
});

test('2.68: повтор отправки того же снимка (ответ потерялся) не создаёт второе фото; номер снимка — только своего вида', async () => {
  const o = await inWork('Осмотр — повтор при плохой связи');
  const { token } = await issue(o, { days: 1 });
  const id = crypto.randomBytes(16).toString('hex');
  let r = await shoot(token, 'facade', { headers: { ...GEO, 'x-photo-id': id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { step: 'facade', photos: 1, geo: true });
  // Тот же снимок ещё раз — и ещё два одновременно: фото по-прежнему одно.
  r = await shoot(token, 'facade', { headers: { ...GEO, 'x-photo-id': id } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { step: 'facade', photos: 1, geo: true, repeated: true });
  const both = await Promise.all([1, 2].map(() => shoot(token, 'kitchen', { headers: { 'x-photo-id': 'same-kitchen-shot' } })));
  assert.deepEqual(both.map((x) => x.status), [201, 201]);
  assert.deepEqual(both.map((x) => x.body.photos), [1, 1]);
  // Другой снимок того же шага — второе фото; без номера — как раньше.
  assert.equal((await shoot(token, 'facade', { headers: { 'x-photo-id': crypto.randomBytes(16).toString('hex') } })).body.photos, 2);
  assert.equal((await shoot(token, 'facade')).body.photos, 3);
  assert.equal((await shoot(token, 'facade', { headers: { 'x-photo-id': 'bad id!' } })).status, 400);
  assert.equal((await shoot(token, 'facade', { headers: { 'x-photo-id': 'x' } })).status, 400);
  const docs = (await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents.filter((d) => d.kind === 'inspection');
  assert.equal(docs.length, 4);
  const [{ n }] = await S.sql`select count(*)::int as n from audit_log where action = 'inspect.photo' and subject_id = ${o.id}`;
  assert.equal(n, 4, 'повтор не пишется в журнал вторым фото');
  // Номер снимка привязан к ссылке: по новой ссылке тот же номер — новое фото (это уже другой осмотр).
  const { token: t2 } = await issue(o, { days: 1 });
  assert.equal((await shoot(t2, 'facade', { headers: { 'x-photo-id': id } })).body.photos, 1);
});

test('2.71: картинка снимка для дела — впереди фото тем же запросом; видят те, кто видит заявку; без картинки — «не найдено»', async () => {
  const o = await inWork('Осмотр — картинки в деле');
  const { token } = await issue(o, { days: 1 });
  const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('маленькая-копия')]);
  let r = await shoot(token, 'facade', { buf: Buffer.concat([THUMB, PNG]), type: 'image/png', headers: { 'x-thumb-bytes': String(THUMB.length) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await shoot(token, 'kitchen')).status, 201, 'без картинки — как раньше');
  // Неверная длина или не JPEG впереди — снимок не принимается (иначе фото легло бы обрезанным).
  for (const [h, buf] of [['0', JPEG], ['abc', JPEG], [String(JPEG.length), JPEG], ['70000', Buffer.concat([Buffer.alloc(70000, 1), JPEG])],
    ['12', Buffer.concat([PNG.subarray(0, 12), JPEG])]]) {
    assert.equal((await shoot(token, 'rooms', { buf, headers: { 'x-thumb-bytes': h } })).body.error, 'bad_thumb', h);
  }
  const steps = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.steps;
  const facade = steps.find((s) => s.id === 'facade').photos[0];
  const kitchen = steps.find((s) => s.id === 'kitchen').photos[0];
  assert.equal(facade.thumb, true);
  assert.equal(kitchen.thumb, false);
  assert.equal(steps.find((s) => s.id === 'rooms').photos.length, 0);
  // Само фото — без картинки впереди: целиком тот PNG, что сняли.
  const [doc] = await S.sql`select storage_key, size_bytes, mime from documents where id = ${facade.document_id}`;
  assert.equal(doc.mime, 'image/png');
  assert.equal(doc.size_bytes, PNG.length);
  assert.ok((await S.providers.storage.get(doc.storage_key)).equals(PNG));
  for (const c of [spec, owner, dispatcher]) {
    const t = await c.req('GET', `/api/documents/${facade.document_id}/thumb`, undefined, { binary: true });
    assert.equal(t.status, 200);
    assert.ok(t.body.equals(THUMB));
    assert.equal(t.headers.get('content-type'), 'image/jpeg');
    assert.match(t.headers.get('cache-control'), /private/);
  }
  assert.equal((await spec2.req('GET', `/api/documents/${facade.document_id}/thumb`)).status, 404, 'посторонний эксперт');
  assert.equal((await anon().req('GET', `/api/documents/${facade.document_id}/thumb`)).status, 401);
  assert.equal((await spec.req('GET', `/api/documents/${kitchen.document_id}/thumb`)).status, 404, 'снимок без картинки');
  // Не фото осмотра — картинки нет.
  const up = await owner.req('POST', `/api/orders/${o.id}/documents`, JPEG, { raw: true, headers: { 'content-type': 'image/jpeg', 'x-file-name': 'scan.jpg' } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await owner.req('GET', `/api/documents/${up.body.document.id}/thumb`)).status, 404);
});

// 2.85: ссылку выдали, а фото нет 2 дня — эксперту одно напоминание в ленте и строка в «Сегодня»; в деле — «Отправить снова».
const silentEvents = async (orderId) => (await S.sql`select user_id, event from notifications where order_id = ${orderId} and event = 'inspection_silent'`);
const ago = (linkId, hours) => S.sql`update inspection_links set created_at = now() - make_interval(hours => ${hours}) where id = ${linkId}`;
const todaySilent = async (c) => (await c.req('GET', '/api/today')).body.expert.inspect_silent;

test('2.85: ссылка 2 дня без фото — эксперту одно напоминание, строка в «Сегодня» и в деле; новая ссылка — по ней снова', async () => {
  const o = await inWork('Осмотр — молчит');
  const first = await issue(o, { days: 1 });
  await ago(first.link.id, 47);
  await remindSilentInspections(S.sql);
  assert.deepEqual(await silentEvents(o.id), [], 'меньше 2 дней — рано');
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.silent, null);
  assert.ok(!(await todaySilent(spec)).some((x) => x.id === o.id));

  // 2 дня, срок ссылки (1 день) уже истёк — владелец так и не снял: напоминание один раз.
  await ago(first.link.id, 49);
  await S.sql`update inspection_links set expires_at = now() - interval '1 day' where id = ${first.link.id}`;
  await remindSilentInspections(S.sql);
  await remindSilentInspections(S.sql);
  assert.deepEqual((await silentEvents(o.id)).map((r) => [r.user_id, r.event]), [[spec.user.id, 'inspection_silent']], 'один раз и только эксперту');
  const g = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.equal(g.silent.link_id, first.link.id);
  assert.equal(g.silent.expired, true);
  const t = (await todaySilent(spec)).find((x) => x.id === o.id);
  assert.ok(t && t.expired && t.link_at, JSON.stringify(t));
  // Заказчик дела и чужой эксперт этого не видят.
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/inspection`)).body.silent, null);
  assert.ok(!((await todaySilent(spec2)) ?? []).some((x) => x.id === o.id));
  // СМС-текст напоминания — без названия заявки.
  const [sms] = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                            where n.order_id = ${o.id} and n.event = 'inspection_silent'`;
  assert.ok(!sms || !/молчит/.test(sms.body), sms?.body);

  // «Отправить снова» = новая ссылка: строка уходит; через 2 дня молчания по новой — новое напоминание.
  const second = await issue(o, { days: 3 });
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.silent, null);
  assert.ok(!(await todaySilent(spec)).some((x) => x.id === o.id));
  await ago(second.link.id, 50);
  await remindSilentInspections(S.sql);
  assert.equal((await silentEvents(o.id)).length, 2);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.silent.expired, false);

  // Пришло фото — молчания нет; новых напоминаний тоже.
  assert.equal((await shoot(second.token, 'facade', { headers: GEO })).status, 201);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.silent, null);
  assert.ok(!(await todaySilent(spec)).some((x) => x.id === o.id));
});

test('2.85: без напоминания — отозванная ссылка, «Готово», дело не в работе, фото с выезда помощника после ссылки', async () => {
  const revoked = await inWork('Осмотр — отозвана');
  const a = await issue(revoked);
  assert.equal((await spec.req('DELETE', `/api/orders/${revoked.id}/inspection/${a.link.id}`)).status, 204);
  await ago(a.link.id, 72);

  const finished = await inWork('Осмотр — готово');
  const b = await issue(finished);
  assert.equal((await shoot(b.token, 'facade')).status, 201);
  assert.equal((await finish(b.token)).status, 200);
  await ago(b.link.id, 72);

  const done = await inWork('Осмотр — не в работе');
  const c = await issue(done);
  await ago(c.link.id, 72);
  await S.sql`update orders set status = 'review' where id = ${done.id}`;

  // Фото пришло иначе (например, с выезда помощника) после выдачи ссылки — осмотр есть, напоминать не о чем.
  const other = await inWork('Осмотр — фото есть');
  const d = await issue(other);
  assert.equal((await shoot(d.token, 'facade')).status, 201);
  await S.sql`update inspection_links set revoked_at = null where order_id = ${other.id}`;
  const e = await issue(other);
  await S.sql`update inspection_photos set received_at = now() where link_id = ${d.link.id}`;
  await ago(e.link.id, 72);

  await remindSilentInspections(S.sql);
  for (const o of [revoked, finished, done, other]) assert.deepEqual(await silentEvents(o.id), [], o.title);
});
