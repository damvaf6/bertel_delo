// Шаги заказа перевода (задача 2а.6, задача штаба 3f617197): передача оригинала, подпись у нотариуса, файл нотариуса в
// кабинет, выдача бумаги. Отмечают переводчик или платформа, заказчик видит; шаги «до сдачи» нужны для сдачи на проверку.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import translation from '../../src/modules/translation.mjs';

let S, dispatcher, owner, stranger, tr, tr2;
const soon = addDays(todayMsk(), 7);
const BASE = { recipient: 'zags', language: 'en', direction: 'to_ru', doc_kind: 'civil', docs: 1, pages: 1 };

before(async () => {
  S = await startApp();
  dispatcher = await login(S, '+79990000980');
  owner = await login(S, '+79990000981');
  stranger = await login(S, '+79990000982');
  tr = await login(S, '+79990000983');
  tr2 = await login(S, '+79990000984');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  const permits = [['translation', 'plain'], ['translation', 'notary_paper'], ['translation', 'notary_file']];
  await makeSpecialist(S.sql, tr.user.id, { permits, capacity: 20, taxStatus: 'self_employed', languages: ['en'] });
  await makeSpecialist(S.sql, tr2.user.id, { permits, capacity: 20, taxStatus: 'ip', languages: ['en'] });
});
after(async () => { await S?.close(); });

async function order(service, fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'translation', service, title: `Перевод ${service}` })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields: { ...BASE, ...fields } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: tr.user.id, from: 'matching' })).status, 200);
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}
const upload = async (o, name = 'перевод.pdf') => {
  const r = await tr.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`%PDF ${name}`), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.document;
};
const submit = (o) => tr.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' });
const ids = (r) => r.body.steps.map((s) => s.id);

test('шаги в описании модуля: по услуге и по выбору в заявке, со своим названием', () => {
  validateModule(translation);
  const reg = createRegistry();
  const titles = (service, fields) => reg.steps('translation', service, fields).map((s) => s.title);
  assert.deepEqual(titles('notary_paper', { original: 'meeting', delivery: 'post' }),
    ['Оригинал получен при встрече', 'Перевод подписан у нотариуса', 'Бумажный перевод отправлен почтой']);
  assert.deepEqual(titles('notary_file', { original: 'notarial_copy', delivery: 'none' }),
    ['Нотариальная копия получена', 'Перевод подписан у нотариуса', 'Файл нотариуса загружен']);
  assert.deepEqual(titles('plain', { delivery: 'none' }), [], 'без бумаги у перевода без нотариуса шагов нет');
  assert.deepEqual(titles('plain', { delivery: 'courier' }), ['Бумажный перевод передан курьеру']);
  assert.deepEqual(reg.steps('expertise', 'realty', {}), [], 'у экспертизы шагов нет');

  const bad = (steps) => assert.throws(() => validateModule({ ...translation, steps }));
  bad([{ id: 'x', title: 'X', by: ['customer'] }]);
  bad([{ id: 'x', title: 'X', by: ['executor'], file: true }]);
  bad([{ id: 'x', by: ['executor'], field: 'delivery', titles: { teleport: 'Телепорт' } }]);
  bad([{ id: 'x', by: ['executor'], titles: { pickup: 'Выдан' }, title: 'X' }]);
  bad([{ id: 'x', title: 'X', by: ['executor'], services: ['nope'] }]);
});

test('нотариальный на бумаге: без отметок не сдать; отметили — сдаётся; заказчик видит ход и получает уведомление', async () => {
  const o = await order('notary_paper', { urgent: 'no', original: 'courier', delivery: 'courier' });
  await upload(o);
  const no = await submit(o);
  assert.equal(no.status, 400);
  assert.equal(no.body.error, 'steps_missing');
  assert.match(no.body.message, /Оригинал получен от курьера; Перевод подписан у нотариуса/);

  // Заказчик видит шаги, но не отмечает; посторонний — «не найдено».
  const seen = await owner.req('GET', `/api/orders/${o.id}/steps`);
  assert.deepEqual(ids(seen), ['original', 'notarized', 'handed']);
  assert.ok(seen.body.steps.every((s) => !s.done && !s.can_mark));
  assert.equal(seen.body.files, undefined, 'заказчику — без списка файлов');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/steps/original`, {})).status, 403);
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}/steps`)).status, 404);
  assert.equal((await tr2.req('POST', `/api/orders/${o.id}/steps/original`, {})).status, 404, 'другой переводчик');
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/nope`, {})).status, 404, 'такого шага нет');
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notary_file`, {})).status, 404, 'файл нотариуса — не у бумажного');

  // Оригинал получила платформа: переводчику — уведомление; заказчику — тоже.
  const before = await S.sql`select user_id, event from notifications where order_id = ${o.id} and event like 'order_step%'`;
  assert.equal(before.length, 0);
  const d = await dispatcher.req('POST', `/api/orders/${o.id}/steps/original`, { note: 'курьер привёз 12.10' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/steps/original`, {})).status, 409, 'дважды не отметить');
  // Подписать у нотариуса — только переводчик.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/steps/notarized`, {})).status, 403);
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notarized`, { note: 'x'.repeat(301) })).status, 400);
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notarized`, { note: 'нотариус Тестова, окно вт' })).status, 200);
  const sent = await S.sql`select user_id, event from notifications where order_id = ${o.id} and event like 'order_step%' order by id`;
  assert.deepEqual(sent.map((n) => [n.user_id, n.event]), [
    [owner.user.id, 'order_step'], [tr.user.id, 'order_step_executor'], [owner.user.id, 'order_step'],
  ]);

  const v = (await owner.req('GET', `/api/orders/${o.id}/steps`)).body.steps;
  assert.deepEqual(v.map((s) => [s.id, s.done]), [['original', true], ['notarized', true], ['handed', false]]);
  assert.equal(v[0].note, 'курьер привёз 12.10');
  assert.ok(!JSON.stringify(v).includes(tr.user.id), 'кто отметил — заказчику не показывается');

  // Снять и отметить снова можно, пока перевод не сдан.
  assert.equal((await tr.req('DELETE', `/api/orders/${o.id}/steps/notarized`)).status, 200);
  assert.equal((await submit(o)).status, 400);
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notarized`, {})).status, 200);
  // Выдача бумаги — после проверки, но отмечать её до сдачи не обязательно.
  const ok = await submit(o);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await tr.req('DELETE', `/api/orders/${o.id}/steps/original`)).status, 409, 'после сдачи шаги «до сдачи» не меняются');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/steps/handed`, { note: 'курьер 15:00' })).status, 200);
  const handed = (await owner.req('GET', `/api/orders/${o.id}/steps`)).body.steps.find((s) => s.id === 'handed');
  assert.equal(handed.title, 'Бумажный перевод передан курьеру');
  assert.equal(handed.done, true);
});

test('нотариальный файлом: файл нотариуса — свой файл результата; после проверки заказчик видит его с пометкой', async () => {
  const o = await order('notary_file', { doc_kind: 'diploma', original: 'meeting', delivery: 'none' });
  await tr.req('POST', `/api/orders/${o.id}/steps/original`, {});
  await tr.req('POST', `/api/orders/${o.id}/steps/notarized`, {});
  assert.equal((await submit(o)).status, 400, 'нет файла результата');
  const file = await upload(o, 'диплом_нотариус.pdf');
  const left = await submit(o);
  assert.equal(left.body.error, 'steps_missing');
  assert.match(left.body.message, /Файл нотариуса загружен/);

  const mine = (await tr.req('GET', `/api/orders/${o.id}/steps`)).body;
  assert.deepEqual(mine.files.map((f) => f.filename), ['диплом_нотариус.pdf']);
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notary_file`, {})).status, 404, 'без файла');
  const foreign = await S.sql`select id from documents where order_id <> ${o.id} and kind = 'result' limit 1`;
  if (foreign[0]) assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notary_file`, { document_id: foreign[0].id })).status, 400, 'чужой файл');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/steps/notary_file`, { document_id: file.id })).status, 403);
  assert.equal((await tr.req('POST', `/api/orders/${o.id}/steps/notary_file`, { document_id: file.id })).status, 200);

  // Файл удалили — отметка снята, сдать нельзя; загрузили и отметили снова — можно.
  assert.equal((await tr.req('DELETE', `/api/documents/${file.id}`)).status, 204);
  assert.equal((await tr.req('GET', `/api/orders/${o.id}/steps`)).body.steps.find((s) => s.id === 'notary_file').done, false);
  const again = await upload(o, 'диплом_нотариус_2.pdf');
  await tr.req('POST', `/api/orders/${o.id}/steps/notary_file`, { document_id: again.id });
  assert.equal((await submit(o)).status, 200);

  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' })).status, 200);
  const docs = (await owner.req('GET', `/api/orders/${o.id}/documents`)).body.documents.filter((d) => d.kind === 'result');
  assert.deepEqual(docs.map((d) => [d.filename, d.step_file ?? null]), [['диплом_нотариус_2.pdf', 'Файл нотариуса']]);
  // Бумага не нужна — шага выдачи нет.
  assert.deepEqual(ids(await owner.req('GET', `/api/orders/${o.id}/steps`)), ['original', 'notarized', 'notary_file']);
});

test('без нотариуса: шагов до сдачи нет; бумага курьером — шаг выдачи; у экспертизы блока нет', async () => {
  const o = await order('plain', { recipient: 'business', urgent: 'no', delivery: 'courier' });
  await upload(o);
  assert.equal((await submit(o)).status, 200, 'сдаётся без шагов');
  assert.deepEqual(ids(await owner.req('GET', `/api/orders/${o.id}/steps`)), ['handed']);
  const none = await order('plain', { recipient: 'business', urgent: 'no', delivery: 'none' });
  assert.deepEqual((await owner.req('GET', `/api/orders/${none.id}/steps`)).body, { available: false });
});
