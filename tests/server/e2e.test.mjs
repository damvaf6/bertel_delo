// Задача 1.11: сквозной путь тестовой заявки на экспертизу через операции сервера — роли и допуск выдаёт администратор,
// заказчик заполняет и отправляет заявку, диспетчер назначает цену, заказчик платит, диспетчер предлагает дело,
// специалист принимает, сдаёт результат с ИИ-проверкой, диспетчер проверяет по правилам, заказчик получает результат
// и акт, закрывает; выплата исполнителю. На каждом шаге посторонний не видит ничего по заявке (ни чтение, ни запись),
// а СМС не содержат названия заявки и имён.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, signResults } from '../helpers.mjs';
import { grantRole } from '../../src/tools/grant-role.mjs';

let S, admin, customer, dispatcher, spec, stranger;
const TITLE = 'Сквозная оценка квартиры';
const NAMES = ['Тестова Заказчица', 'Тестов Оценщик', TITLE];
const deadline = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
const file = (c, path, text, name, type = 'text/plain', extra = {}) => c.req('POST', path, Buffer.from(text),
  { raw: true, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...extra } });

before(async () => {
  S = await startApp();
  await grantRole(S.sql, '+79990001501', 'admin');
  admin = await login(S, '+79990001501');
  customer = await login(S, '+79990001502');
  dispatcher = await login(S, '+79990001503');
  spec = await login(S, '+79990001504');
  stranger = await login(S, '+79990001505');
  await customer.req('PATCH', '/api/me', { full_name: 'Тестова Заказчица' });
  await spec.req('PATCH', '/api/me', { full_name: 'Тестов Оценщик' });
});
after(async () => { await S?.close(); });

// Посторонний: ни одна операция по заявке и её документам не проходит, название не утекает.
async function strangerBlocked(o, docIds = []) {
  const tries = [
    ['GET', `/api/orders/${o.id}`], ['PATCH', `/api/orders/${o.id}`, { title: 'чужое' }],
    ['POST', `/api/orders/${o.id}/status`, { to: 'cancelled', from: o.status }],
    ['GET', `/api/orders/${o.id}/documents`], ['GET', `/api/orders/${o.id}/messages`],
    ['POST', `/api/orders/${o.id}/messages`, { body: 'чужое' }], ['GET', `/api/orders/${o.id}/review`],
    ['POST', `/api/orders/${o.id}/review/ai`], ['GET', `/api/orders/${o.id}/money`],
    ['PUT', `/api/orders/${o.id}/price`, { price: '1' }], ['POST', `/api/orders/${o.id}/payments`],
    ['GET', `/api/orders/${o.id}/candidates`], ['POST', `/api/orders/${o.id}/offer`, { specialist_id: stranger.user.id, from: o.status }],
    ['PATCH', `/api/orders/${o.id}/responsible`, { user_id: stranger.user.id }],
    ...docIds.flatMap((d) => [['GET', `/api/documents/${d}/link`], ['DELETE', `/api/documents/${d}`]]),
  ];
  for (const [m, p, b] of tries) {
    const r = await stranger.req(m, p, b);
    assert.ok([403, 404].includes(r.status), `${m} ${p}: ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes(TITLE), `${m} ${p}: название утекло`);
  }
  const up = await file(stranger, `/api/orders/${o.id}/documents`, 'чужой файл', 'x.txt');
  assert.ok([403, 404].includes(up.status));
  const list = (await stranger.req('GET', '/api/orders')).body.orders;
  assert.equal(list.some((x) => x.id === o.id), false);
}
const get = async (c, o) => (await c.req('GET', `/api/orders/${o.id}`)).body.order;

test('сквозной путь заявки на оценку: от заявки заказчика до выплаты исполнителю; посторонний не видит ничего', async () => {
  // Администратор (назначен командой) выдаёт роли и допуск.
  assert.equal((await admin.req('PATCH', `/api/admin/users/${dispatcher.user.id}`, { platform_role: 'dispatcher' })).status, 200);
  assert.equal((await admin.req('PUT', `/api/admin/specialists/${spec.user.id}`, { regions: ['moscow', 'mo'], capacity: 5 })).status, 200);
  assert.equal((await admin.req('POST', `/api/admin/specialists/${spec.user.id}/permits`, { module: 'expertise', service: 'realty' })).status, 201);
  S.providers.sms.reset();

  // Заказчик: заявка, поля, документ, отправка.
  let o = (await customer.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: TITLE })).body.order;
  assert.equal(o.status, 'new');
  assert.equal((await customer.req('PATCH', `/api/orders/${o.id}`, {
    deadline, fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Тестовая, д. 11', area: 42 },
  })).status, 200);
  const egrn = await file(customer, `/api/orders/${o.id}/documents`, '%PDF-1.4 выписка', 'Выписка ЕГРН.pdf', 'application/pdf');
  assert.equal(egrn.status, 201);
  await strangerBlocked(o, [egrn.body.document.id]);
  assert.equal((await customer.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  o = await get(customer, o);
  assert.equal(o.status, 'matching');

  // Диспетчер: цена; заказчик платит (поддельная ЮKassa).
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '18000' })).status, 200);
  assert.equal((await customer.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  assert.equal((await customer.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  await strangerBlocked(o, [egrn.body.document.id]);

  // Подбор: специалист с допуском — среди кандидатов; предложение, принятие.
  const cands = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(cands.some((c) => c.user_id === spec.user.id), 'специалист с допуском в подборе');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  o = await get(spec, o);
  await strangerBlocked(o, [egrn.body.document.id]);

  // Работа: результат, ИИ-проверка, сообщение, сдача. До проверки заказчик результата не видит.
  const res = await file(spec, `/api/orders/${o.id}/results`, 'Отчёт об оценке. Итоговая стоимость 12 000 000 руб.', 'Отчёт.txt');
  assert.equal(res.status, 201);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/messages`, { body: 'Отчёт приложен.' })).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: 'in_work', to: 'review' })).status, 200);
  const seen = (await customer.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.equal(seen.some((d) => d.kind === 'result'), false, 'результат до проверки скрыт от заказчика');
  assert.equal((await customer.req('GET', `/api/documents/${res.body.document.id}/link`)).status, 404);
  o = await get(spec, o);
  await strangerBlocked(o, [egrn.body.document.id, res.body.document.id]);

  // Диспетчер: проверка по всем правилам, «готово».
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.ok(rv.checks.length > 3);
  for (const c of rv.checks) {
    assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round })).status, 200);
  }
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { from: 'review', to: 'done' })).status, 200);

  // Заказчик: результат виден и скачивается, акт, закрытие.
  const docs = (await customer.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.ok(docs.some((d) => d.kind === 'result' && d.filename === 'Отчёт.txt'));
  const link = await customer.req('GET', `/api/documents/${res.body.document.id}/link`);
  assert.equal(link.status, 200);
  assert.ok(link.body.url);
  const money = (await customer.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.equal(money.paid, true);
  const [act] = await S.sql`select kind from closing_documents where order_id = ${o.id} and kind = 'act'`;
  assert.ok(act, 'акт заказчику');
  assert.equal((await customer.req('POST', `/api/orders/${o.id}/status`, { from: 'done', to: 'closed' })).status, 200);
  o = await get(customer, o);
  assert.equal(o.status, 'closed');
  await strangerBlocked(o, [egrn.body.document.id, res.body.document.id]);

  // Выплата исполнителю: 80% от 18 000 ₽.
  const [payout] = await S.sql`select amount_kop, status, executor_user_id from payouts where order_id = ${o.id}`;
  assert.equal(Number(payout.amount_kop), 1_440_000);
  assert.equal(payout.status, 'succeeded');
  assert.equal(payout.executor_user_id, spec.user.id);

  // Уведомления дошли до каждой стороны; СМС без названия заявки и имён; постороннему — ничего.
  for (const c of [customer, dispatcher, spec]) {
    assert.ok((await c.req('GET', '/api/notifications')).body.notifications.length > 0);
  }
  assert.equal((await stranger.req('GET', '/api/notifications')).body.notifications.length, 0);
  const sms = S.providers.sms.calls.filter((x) => x.method === 'send');
  assert.ok(sms.length > 0);
  for (const x of sms) for (const n of NAMES) assert.ok(!x.args.text.includes(n), `СМС с «${n}»: ${x.args.text}`);
  assert.equal(sms.some((x) => x.args.phone === stranger.user.phone), false);
});
