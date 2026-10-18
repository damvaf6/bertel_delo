// Ответ заказчику сразу после отправки заявки (задача штаба 3fd17197): срок — настройка администратора по модулю, без неё
// ответа со сроком нет; одна строка «принята, обычно … в течение N часов»; не успели — один раз «задерживаемся» заказчику
// и сигнал диспетчерам; цена назначена — обещание снято. Учебные данные (+7999000xxxx).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { remindAck } from '../../src/orders/ack.mjs';

let S, admin, owner, dispatcher, spec;
const HOUR = 3_600_000;

before(async () => {
  S = await startApp();
  admin = await login(S, '+79990000981');
  owner = await login(S, '+79990000982');
  dispatcher = await login(S, '+79990000983');
  spec = await login(S, '+79990000984');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

const PASSPORT = { recipient: 'mvd', language: 'en', direction: 'to_ru', doc_kind: 'identity', docs: 1, pages: 1, urgent: 'no', delivery: 'pickup', original: 'courier' };

async function submitted(module = 'expertise') {
  const service = module === 'expertise' ? 'realty' : 'notary_paper';
  const fields = module === 'expertise' ? { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 7' } : PASSPORT;
  const o = (await owner.req('POST', '/api/orders', { module, service, title: 'Тест ответа' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 20), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  return (await S.sql`select * from orders where id = ${o.id}`)[0];
}
const ackOf = async (c, id) => (await c.req('GET', `/api/orders/${id}`)).body.ack;
const events = async (userId, orderId) => (await S.sql`select event from notifications where user_id = ${userId} and order_id = ${orderId}
                                                      and event like 'ack%' order by id`).map((r) => r.event);
const save = (hours) => admin.req('PUT', '/api/admin/order-ack', { hours });

test('без настройки — ответа со сроком нет и «задерживаемся» не приходит (до решения Дамира всё выключено)', async () => {
  const view = (await admin.req('GET', '/api/admin/order-ack')).body.ack;
  assert.deepEqual(view.modules.map((m) => [m.id, m.hours]), [['expertise', null], ['translation', null]]);
  assert.deepEqual(view.history, []);
  const o = await submitted();
  assert.equal(o.ack_due_at, null);
  assert.equal(await ackOf(owner, o.id), null);
  assert.equal(await remindAck(S.sql, { now: new Date(Date.now() + 1000 * HOUR) }), 0);
  assert.deepEqual(await events(owner.user.id, o.id), []);
});

test('настройка: только целые часы от 1 до 168 или пусто; история — кто и что', async () => {
  for (const bad of [{ expertise: 0 }, { expertise: 1.5 }, { expertise: 169 }, { expertise: 'сутки' }]) {
    const r = await save(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.message ?? r.body.error?.message ?? JSON.stringify(r.body), /Экспертиза|часов/);
  }
  const r = await save({ expertise: 24, translation: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed, ['expertise']);
  assert.deepEqual(r.body.ack.modules.map((m) => m.hours), [24, null]);
  assert.equal(r.body.ack.history.length, 1);
  assert.deepEqual(r.body.ack.history[0].hours, { expertise: 24, translation: null });
  assert.deepEqual((await save({ expertise: 24 })).body.changed, [], 'то же самое — без новой строки истории');
  assert.equal((await admin.req('GET', '/api/admin/order-ack')).body.ack.history.length, 1);
});

test('заявка отправлена — одна строка с номером и сроком; срок — снимок при отправке; не успели — «задерживаемся» один раз', async () => {
  const o = await submitted();
  assert.equal(new Date(o.ack_due_at) - new Date(o.submitted_at), 24 * HOUR, 'срок — из настройки модуля');
  const ack = await ackOf(owner, o.id);
  assert.equal(ack.late, false);
  assert.match(ack.text, new RegExp(`^Заявка № ${o.id.slice(0, 8).toUpperCase()} принята\\. Обычно диспетчер назначает цену в течение 24 часов — до .+ МСК\\. Если не успеем — сообщим\\.$`));
  assert.ok(await ackOf(dispatcher, o.id), 'диспетчер видит, что обещано заказчику');
  assert.equal(await ackOf(spec, o.id), undefined, 'постороннему заявка не видна вовсе');
  // Сразу после отправки — никаких уведомлений заказчику (ответ — на экране и в письме), без дублей.
  assert.deepEqual(await events(owner.user.id, o.id), []);

  // Правка настройки потом не сдвигает данное обещание.
  assert.equal((await save({ expertise: 48 })).status, 200);
  assert.equal(new Date((await S.sql`select ack_due_at from orders where id = ${o.id}`)[0].ack_due_at).getTime(), new Date(o.ack_due_at).getTime());

  // До срока — тишина; после — заказчику и диспетчеру по одному; повтор не дублирует.
  assert.equal(await remindAck(S.sql, { now: new Date(Date.now() + 23 * HOUR) }), 0);
  assert.equal(await remindAck(S.sql, { now: new Date(Date.now() + 25 * HOUR) }), 2);
  assert.equal(await remindAck(S.sql, { now: new Date(Date.now() + 50 * HOUR) }), 0);
  assert.deepEqual(await events(owner.user.id, o.id), ['ack_late']);
  assert.deepEqual(await events(dispatcher.user.id, o.id), ['ack_late_staff']);
  const late = await ackOf(owner, o.id);
  assert.equal(late.late, true);
  assert.match(late.text, /задерживаемся с ценой/);
  const feed = (await owner.req('GET', '/api/notifications')).body.notifications.find((n) => n.order_id === o.id);
  assert.match(feed.title, /^Задерживаемся с ценой/);

  // Цена назначена — строка уходит.
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '15000' })).status, 200);
  assert.equal(await ackOf(owner, o.id), null);
});

test('ответили вовремя — «задерживаемся» не приходит; у модуля без срока — ответа со сроком нет', async () => {
  const o = await submitted();
  assert.equal(new Date(o.ack_due_at) - new Date(o.submitted_at), 48 * HOUR, 'новая настройка — для новых заявок');
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '12000' })).status, 200);
  const c = await submitted();
  assert.equal((await owner.req('POST', `/api/orders/${c.id}/status`, { from: 'matching', to: 'cancelled' })).status, 200);
  assert.equal(await remindAck(S.sql, { now: new Date(Date.now() + 100 * HOUR) }), 0);
  assert.deepEqual(await events(owner.user.id, o.id), []);
  assert.deepEqual(await events(owner.user.id, c.id), []);

  const t = await submitted('translation');
  assert.equal(t.ack_due_at, null);
  assert.equal(await ackOf(owner, t.id), null);
});
