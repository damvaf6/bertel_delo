// Работа по делу (задача 1.5): результат, проверка по правилам с кругами, замечания исполнителю, переписка.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, spec;
const READY = { deadline: addDays(todayMsk(), 15), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 5' } };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000501');
  dispatcher = await login(S, '+79990000502');
  spec = await login(S, '+79990000503');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await S.sql`update users set full_name = 'Тестовый Диспетчер' where id = ${dispatcher.user.id}`;
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty'], ['expertise', 'goods']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to, reason) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, reason, from: cur.status });
}
const putResult = (o, name = 'отчёт.pdf') => spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('тестовый отчёт'), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});
const review = (c, o) => c.req('GET', `/api/orders/${o.id}/review`).then((r) => r.body);
const mark = (o, check, verdict, round, note) => dispatcher.req('PUT', `/api/orders/${o.id}/review/${check}`, { verdict, round, note });

async function inWork(service = 'realty') {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service })).body.order;
  const fields = service === 'realty' ? READY.fields : { purpose: 'deal', region: 'moscow', subject: 'Тестовый товар: брак', questions: 'Есть ли производственный брак?' };
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: READY.deadline, fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

test('правила проверки — по услуге: у товароведческой нет правила про аналоги', async () => {
  const realty = await inWork('realty');
  const goods = await inWork('goods');
  const ids = (await review(dispatcher, realty)).checks.map((c) => c.id);
  assert.ok(ids.includes('analogs'));
  assert.ok(ids.includes('calculation'));
  assert.ok(!(await review(dispatcher, goods)).checks.some((c) => c.id === 'analogs'));
});

test('проверка по кругам: замечание не пускает в «готово», исполнитель видит замечания, новый круг начинается с чистого листа', async () => {
  const o = await inWork();
  assert.equal((await putResult(o)).status, 201);
  assert.equal((await step(spec, o, 'review')).status, 200);
  let r = await review(dispatcher, o);
  assert.equal(r.round, 1);
  assert.equal(r.summary.unchecked, r.summary.total);
  for (const c of r.checks) assert.equal((await mark(o, c.id, 'ok', 1)).status, 200);
  assert.equal((await mark(o, 'calculation', 'issue', 1, 'Итог не сходится с таблицей расчёта')).status, 200, 'отметку можно поменять');
  const done = await step(dispatcher, o, 'done');
  assert.equal(done.status, 409);
  assert.match(done.body.message, /Расчёт/);
  assert.equal((await step(dispatcher, o, 'in_work', 'Исправьте расчёт')).status, 200);

  // Исполнитель видит замечание прошлого круга и правит результат.
  r = await review(spec, o);
  assert.equal(r.details, true);
  const calc = r.checks.find((c) => c.id === 'calculation');
  assert.equal(calc.verdict, 'issue');
  assert.equal(calc.note, 'Итог не сходится с таблицей расчёта');
  assert.equal((await mark(o, 'calculation', 'ok', 1)).status, 409, 'пока дело в работе, отметки не ставятся');
  assert.equal((await putResult(o, 'отчёт-исправленный.pdf')).status, 201);
  assert.equal((await step(spec, o, 'review')).status, 200);

  r = await review(dispatcher, o);
  assert.equal(r.round, 2);
  assert.equal(r.summary.unchecked, r.summary.total, 'новый круг — без старых отметок');
  for (const c of r.checks.slice(0, -1)) assert.equal((await mark(o, c.id, 'ok', 2)).status, 200);
  assert.equal((await step(dispatcher, o, 'done')).status, 409, 'одно правило не проверено');
  assert.equal((await mark(o, r.checks.at(-1).id, 'ok', 2)).status, 200);
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  const [{ n }] = await S.sql`select count(*)::int as n from result_checks where order_id = ${o.id}`;
  assert.equal(n, r.summary.total * 2, 'отметки обоих кругов сохранены');
  const docs = (await owner.req('GET', `/api/orders/${o.id}/documents`)).body.documents.filter((d) => d.kind === 'result');
  assert.deepEqual(docs.map((d) => d.filename), ['отчёт.pdf', 'отчёт-исправленный.pdf']);
});

test('переписка: служебные видят имена авторов, у остальных — только сторона; длина ограничена', async () => {
  const o = await inWork();
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/messages`, { body: 'Уточните адрес' })).status, 201);
  const long = await owner.req('POST', `/api/orders/${o.id}/messages`, { body: 'я'.repeat(4001) });
  assert.equal(long.status, 400);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/messages`, { body: '<b>Адрес верный</b>' })).status, 201);
  const d = (await dispatcher.req('GET', `/api/orders/${o.id}/messages`)).body.messages;
  assert.equal(d[0].author_name, 'Тестовый Диспетчер');
  assert.equal(d[1].body, '<b>Адрес верный</b>', 'текст хранится как есть, страница выводит его только как текст');
  const s = (await spec.req('GET', `/api/orders/${o.id}/messages`)).body.messages;
  assert.deepEqual(s.map((m) => [m.side, m.author_name]), [['dispatcher', null], ['customer', null]]);
  const [{ n }] = await S.sql`select count(*)::int as n from audit_log where subject_id = ${o.id} and action = 'message.post'`;
  assert.equal(n, 2);
});

test('отказ после переписки: прежний исполнитель больше не видит ни дело, ни переписку', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  await step(owner, o, 'matching');
  await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' });
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/messages`, { body: 'Какой этаж?' })).status, 201);
  assert.equal((await step(spec, o, 'matching', 'Не успеваю к сроку')).status, 200);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/messages`)).status, 404);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/messages`, { body: 'ещё' })).status, 404);
});
