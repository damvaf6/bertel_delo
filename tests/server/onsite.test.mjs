// Экспресс-услуга (задача 2.4): заказчик выбирает экспресс; исполнитель назначает выезд помощнику на объекте; помощник
// снимает по шагам осмотра (время и геометка у каждого фото) и заполняет данные с объекта; эксперт работает дистанционно.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

let S, owner, dispatcher, admin, spec, spec2, helper, helperMo, helperOff;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Экспрессная ул., 5', area: '52', comment: 'Ключи у соседки Тестовой' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-выезда')]);
const GEO = { 'x-lat': '55.7601', 'x-lon': '37.6202', 'x-accuracy': '9.4' };
const soon = () => new Date(Date.now() + 2 * 86400_000).toISOString();

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990002401');
  dispatcher = await login(S, '+79990002402');
  admin = await login(S, '+79990002403');
  spec = await login(S, '+79990002404');
  spec2 = await login(S, '+79990002405');
  helper = await login(S, '+79990002406');
  helperMo = await login(S, '+79990002407');
  helperOff = await login(S, '+79990002408');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await makeSpecialist(S.sql, spec.user.id);
  await makeSpecialist(S.sql, spec2.user.id);
  await helper.req('PATCH', '/api/me', { full_name: 'Тестов Помощник' });
  // Помощников отмечает администратор: районы — как у специалиста.
  assert.equal((await admin.req('PUT', `/api/admin/specialists/${helper.user.id}`, { onsite: true, regions: ['moscow'] })).body.specialist.onsite, true);
  await admin.req('PUT', `/api/admin/specialists/${helperMo.user.id}`, { onsite: true, regions: ['mo'] });
  await admin.req('PUT', `/api/admin/specialists/${helperOff.user.id}`, { regions: ['moscow'] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

async function inWork(title, { express = true, executor = spec } = {}) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS, express });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: executor.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(executor, o, 'in_work')).status, 200);
  return o;
}

const assign = (o, h = helper, planned = soon(), c = spec) => c.req('POST', `/api/orders/${o.id}/onsite`, { helper_id: h.user.id, planned_at: planned });
const shoot = (vid, stepId, headers = GEO, c = helper) => c.req('POST', `/api/visits/${vid}/photos`, JPEG, {
  raw: true, headers: { 'content-type': 'image/jpeg', 'x-step': stepId, 'x-shot-at': new Date().toISOString(), ...headers },
});
const events = async (u) => (await S.sql`select event, order_id from notifications where user_id = ${u.user.id} order by id`);

test('экспресс в описании модуля: для каких услуг, что видит помощник, какие данные он заполняет; ошибки описания не принимаются', () => {
  const reg = createRegistry();
  const ex = reg.express('expertise', 'realty');
  assert.ok(ex.show.some((f) => f.id === 'address') && !ex.show.some((f) => ['purpose', 'comment'].includes(f.id)), 'ни цели, ни комментария заказчика');
  assert.ok(ex.fields.some((f) => f.id === 'area_measured') && !ex.fields.some((f) => f.id === 'mileage'));
  assert.ok(reg.express('expertise', 'vehicle').fields.some((f) => f.id === 'mileage'));
  assert.equal(reg.express('expertise', 'nope'), null);
  assert.equal(reg.catalog()[0].services.find((s) => s.id === 'realty').express, true);
  const { express, ...none } = structuredClone(expertise);
  assert.equal(createRegistry([none]).express('expertise', 'realty'), null, 'без описания — экспресса нет');
  const bad = (ex2) => assert.throws(() => validateModule({ ...structuredClone(expertise), express: { ...structuredClone(express), ...ex2 } }), /экспресс/);
  bad({ services: ['nope'] });
  bad({ show: ['phone'] });
  bad({ fields: [{ id: 'x1', label: 'Поле', type: 'text', services: ['nope'] }] });
  bad({ fields: [{ id: 'x1', label: 'Поле', type: 'color' }] });
  bad({ extra: 1 });
  const noSteps = { ...structuredClone(expertise), inspection: expertise.inspection.filter((s) => !s.services?.includes('goods')) };
  assert.throws(() => validateModule(noSteps), /нет шагов осмотра/, 'помощник снимает по шагам осмотра — без них экспресса нет');
});

test('заказчик выбирает экспресс в заявке; после отправки не меняется', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Экспресс машины' })).body.order;
  assert.equal(o.express, false);
  assert.equal(o.express_available, true);
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { express: 'да' })).status, 400);
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { express: true });
  assert.equal(r.body.order.express, true);
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { title: 'Другое название' })).body.order.express, true, 'остаётся при правке');
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.order.express, true);
});

test('выезд назначает исполнитель экспресс-заявки в работе — только помощнику в районе объекта; помощник получает уведомление без номера заявки', async () => {
  const plain = await inWork('Обычная заявка', { express: false });
  assert.equal((await assign(plain)).status, 403, 'не экспресс — выезда нет');
  const o = await inWork('Экспресс квартиры Тестова');
  const view = (await spec.req('GET', `/api/orders/${o.id}/onsite`)).body;
  assert.equal(view.can_assign, true);
  assert.deepEqual(view.helpers.map((h) => h.user_id), [helper.user.id], 'только помощник с отметкой, в Москве');
  assert.equal((await assign(o, helperMo)).status, 409, 'другой район');
  assert.equal((await assign(o, helperOff)).status, 409, 'не помощник');
  assert.equal((await assign(o, helper, new Date(Date.now() - 3 * 3600_000).toISOString())).status, 400, 'в прошлом');
  assert.equal((await assign(o, helper, 'завтра')).status, 400);
  assert.equal((await assign(o, helper, soon(), spec2)).status, 404, 'чужой исполнитель заявку не видит');
  const a = await assign(o);
  assert.equal(a.status, 201);
  const ev = (await events(helper)).at(-1);
  assert.deepEqual(ev, { event: 'onsite_assigned', order_id: null });
  const [sms] = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                            where n.user_id = ${helper.user.id} order by d.id desc limit 1`;
  assert.ok(!sms.body.includes('№'), 'в СМС помощнику нет номера заявки');
  const list = (await helper.req('GET', '/api/visits')).body.visits;
  assert.deepEqual(list.map((v) => [v.id, v.state, v.place]), [[a.body.visit.id, 'active', FIELDS.address]]);
  const hv = (await helper.req('GET', `/api/visits/${a.body.visit.id}`)).body.visit;
  assert.equal(hv.service, 'Оценка недвижимости');
  assert.deepEqual(hv.object, [{ id: 'object_type', label: 'Что оцениваем', value: 'Квартира' }, { id: 'address', label: 'Адрес объекта', value: FIELDS.address }, { id: 'area', label: 'Площадь, кв. м', value: 52 }]);
  assert.ok(!JSON.stringify(hv).includes('соседки'), 'комментарий заказчика помощнику не виден');
  assert.ok(hv.steps.some((s) => s.id === 'facade') && hv.fields.some((f) => f.id === 'condition'));
  // Повторное назначение отменяет прежний выезд: у заявки один открытый выезд.
  await S.sql`update specialists set regions = '{moscow,mo}' where user_id = ${helperMo.user.id}`;
  const b = await assign(o, helperMo);
  assert.equal(b.status, 201);
  assert.equal((await helper.req('GET', `/api/visits/${a.body.visit.id}`)).body.visit.state, 'cancelled');
  assert.equal((await events(helper)).at(-1).event, 'onsite_cancelled');
  assert.equal((await shoot(a.body.visit.id, 'facade')).status, 410, 'по отменённому выезду фото не принимаются');
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/onsite/${b.body.visit.id}`)).status, 204);
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/onsite/${b.body.visit.id}`)).status, 404, 'уже отменён');
});

test('помощник снимает по шагам и заполняет данные; «Готово» — только с обязательными данными и фото; всё в деле у эксперта', async () => {
  const o = await inWork('Экспресс: полный выезд');
  const vid = (await assign(o)).body.visit.id;
  assert.equal((await shoot(vid, 'nope')).status, 400);
  assert.equal((await helper.req('POST', `/api/visits/${vid}/photos`, Buffer.from('не картинка вовсе'), { raw: true, headers: { 'content-type': 'image/jpeg', 'x-step': 'facade' } })).status, 400);
  const p1 = await shoot(vid, 'facade');
  assert.equal(p1.status, 201);
  assert.deepEqual([p1.body.photos, p1.body.geo], [1, true]);
  assert.equal((await shoot(vid, 'kitchen', {})).body.geo, false, 'без геометки фото принимается');
  assert.equal((await helper.req('POST', `/api/visits/${vid}/finish`, {})).status, 400, 'обязательные данные не заполнены');
  assert.equal((await helper.req('PUT', `/api/visits/${vid}/data`, { data: { area_measured: 'много' } })).status, 400);
  assert.equal((await helper.req('PUT', `/api/visits/${vid}/data`, { data: { mileage: 5 } })).status, 400, 'поле другой услуги');
  const saved = await helper.req('PUT', `/api/visits/${vid}/data`, { data: { condition: 'needs_repair', area_measured: '51,6', floor: '5 из 9', match_order: 'yes', notes: 'Протечка на кухне' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.visit.data.area_measured, 51.6);
  const fin = await helper.req('POST', `/api/visits/${vid}/finish`, {});
  assert.equal(fin.status, 200);
  assert.equal(fin.body.visit.state, 'finished');
  assert.equal((await shoot(vid, 'rooms')).status, 410, 'после «Готово» фото не принимаются');
  assert.deepEqual((await events(spec)).at(-1), { event: 'onsite_done', order_id: o.id });
  // У эксперта: данные с подписями и фото по шагам с временем и местом (в документах заявки, вид «осмотр»).
  const ov = (await spec.req('GET', `/api/orders/${o.id}/onsite`)).body;
  assert.equal(ov.visits[0].state, 'finished');
  assert.equal(ov.visits[0].helper_name, 'Тестов Помощник');
  assert.equal(ov.visits[0].photos, 2);
  assert.ok(ov.visits[0].data.some((d) => d.label === 'Общее состояние' && d.value === 'Нужен ремонт'));
  const insp = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  const facade = insp.steps.find((s) => s.id === 'facade').photos[0];
  assert.equal(facade.visit_id, vid);
  assert.equal(facade.link_id, null);
  assert.equal(facade.geo.lat, 55.7601);
  const [doc] = await S.sql`select kind, uploaded_by from documents where id = ${facade.document_id}`;
  assert.deepEqual([doc.kind, doc.uploaded_by], ['inspection', helper.user.id]);
  // Заказчик видит ход выезда и данные, но не имя помощника.
  const cv = (await owner.req('GET', `/api/orders/${o.id}/onsite`)).body;
  assert.equal(cv.visits[0].helper_name, null);
  assert.equal(cv.can_assign, false);
  // Помощник не открывает файлы заявки (даже свои фото): только выезд.
  assert.equal((await helper.req('GET', `/api/documents/${facade.document_id}/link`)).status, 404);
  // Черновик заключения (2.2) получает данные с объекта.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: null })).status, 201);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('ДАННЫЕ С ОБЪЕКТА') && prompt.includes('Площадь по замеру, кв. м: 51.6') && prompt.includes('Протечка на кухне'));
  assert.ok(prompt.includes('Осмотр · Дом снаружи · 1.jpg'));
});

test('дело ушло у исполнителя — выезд закрывается: помощник больше ничего не присылает', async () => {
  const o = await inWork('Экспресс: передача дела');
  const vid = (await assign(o)).body.visit.id;
  assert.equal((await shoot(vid, 'facade')).status, 201);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'in_work', reason: 'Тест передачи' })).status, 200);
  assert.equal((await helper.req('GET', `/api/visits/${vid}`)).body.visit.state, 'closed');
  assert.equal((await shoot(vid, 'rooms')).status, 410);
  assert.equal((await helper.req('POST', `/api/visits/${vid}/finish`, {})).status, 410);
  // Помощник с отметкой не получает дел как исполнитель без допуска; подбор исполнителя не меняется.
  const cands = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(!cands.some((c) => c.user_id === helper.user.id));
});

test('2.68: помощник при плохой связи — повтор того же снимка не удваивает фото', async () => {
  const o = await inWork('Экспресс: повтор фото');
  const vid = (await assign(o)).body.visit.id;
  const again = await Promise.all([1, 2].map(() => shoot(vid, 'kitchen', { ...GEO, 'x-photo-id': 'kitchen-retry-01' })));
  assert.deepEqual(again.map((x) => [x.status, x.body.photos]), [[201, 1], [201, 1]]);
  const r = await shoot(vid, 'kitchen', { 'x-photo-id': 'kitchen-retry-01' });
  assert.deepEqual([r.status, r.body.photos, r.body.repeated], [201, 1, true]);
  assert.equal((await shoot(vid, 'kitchen', { 'x-photo-id': 'kitchen-retry-02' })).body.photos, 2);
});
