// Уведомления (задача 1.7): кто что получает на каждом шаге заявки, СМС по настройкам и без персональных данных,
// повторы неотправленных СМС, приглашение по номеру без учётной записи, проверка реестра.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember, signResults } from '../helpers.mjs';
import { DELIVERY, deliverPending } from '../../src/notify/notify.mjs';
import { EVENTS, TYPES, validateRegistry } from '../../src/notify/registry.mjs';

let S, owner, dispatcher, dispatcher2, spec, spec2;
const READY = { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тайная ул., 7' } };
const step = (c, o, to, from, reason) => c.req('POST', `/api/orders/${o.id}/status`, { to, from, reason });
const TITLE = 'Оценка квартиры Иванова И.И.';

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000701');
  dispatcher = await login(S, '+79990000702');
  dispatcher2 = await login(S, '+79990000704');
  spec = await login(S, '+79990000703');
  spec2 = await login(S, '+79990000705');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, dispatcher2.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  await makeSpecialist(S.sql, spec2.user.id);
});
after(async () => { await S?.close(); });

// Новые уведомления человека (события) с прошлого вызова.
const seen = new Map();
async function fresh(c) {
  const list = (await c.req('GET', '/api/notifications')).body.notifications;
  const last = seen.get(c.user.id) ?? 0;
  seen.set(c.user.id, Math.max(last, ...list.map((n) => Number(n.id))));
  return list.filter((n) => Number(n.id) > last).map((n) => n.title).reverse();
}
const smsTo = (c) => S.providers.sms.calls.filter((x) => x.method === 'send' && x.args.phone === c.user.phone).map((x) => x.args.text);

async function submitted() {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: TITLE })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, READY)).status, 200);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  await ensurePaid(S.sql, o.id);
  return o;
}
const offer = (o, to, from = 'matching') => dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: to.user.id, from });

test('реестр: у каждого события — известный вид и текст; ошибка в описании останавливает запуск', () => {
  validateRegistry();
  for (const e of Object.values(EVENTS)) assert.ok(TYPES.some((t) => t.id === e.type));
  assert.throws(() => validateRegistry(TYPES, { x: { type: 'нет', title: 'т' } }), /неизвестный вид/);
  assert.throws(() => validateRegistry([...TYPES, TYPES[0]], {}), /повторяется/);
  assert.throws(() => validateRegistry(TYPES, { bad: { type: 'money', title: '' } }), /нет текста/);
});

test('путь заявки: каждый шаг уведомляет нужных людей, но не того, кто сделал шаг', async () => {
  for (const c of [owner, dispatcher, dispatcher2, spec, spec2]) await fresh(c);
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: TITLE })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, READY)).status, 200);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  assert.deepEqual(await fresh(dispatcher), ['Новая заявка ждёт подбора исполнителя']);
  assert.deepEqual(await fresh(dispatcher2), ['Новая заявка ждёт подбора исполнителя'], 'всем диспетчерам');
  assert.deepEqual(await fresh(owner), [], 'себе — нет');

  // Цена назначена — заказчику «оплатите»; оплата — заказчику «получена», диспетчерам «можно предлагать» (1.6а).
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '15000' })).status, 200);
  assert.deepEqual(await fresh(owner), ['Цена назначена — оплатите заявку, чтобы передать её исполнителю']);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  assert.deepEqual(await fresh(owner), ['Оплата получена — подбираем исполнителя']);
  assert.deepEqual(await fresh(dispatcher), ['Заявка оплачена — можно предлагать исполнителю']);
  assert.deepEqual(await fresh(dispatcher2), ['Заявка оплачена — можно предлагать исполнителю']);

  assert.equal((await offer(o, spec)).status, 200);
  assert.deepEqual(await fresh(spec), ['Вам предложено новое дело']);
  // Передали другому — первому «снято», второму «предложено».
  assert.equal((await offer(o, spec2, 'awaiting_executor')).status, 200);
  assert.deepEqual(await fresh(spec), ['Предложение дела снято']);
  assert.deepEqual(await fresh(spec2), ['Вам предложено новое дело']);
  // Отказ — диспетчерам.
  assert.equal((await step(spec2, o, 'matching', 'awaiting_executor', 'Занят')).status, 200);
  assert.deepEqual(await fresh(dispatcher), ['Исполнитель отказался от дела — нужен новый подбор']);
  assert.deepEqual(await fresh(spec2), []);

  assert.equal((await offer(o, spec)).status, 200);
  await fresh(spec);
  assert.equal((await step(spec, o, 'in_work', 'awaiting_executor')).status, 200);
  assert.deepEqual(await fresh(owner), ['Исполнитель принял заявку в работу']);

  // Сообщение исполнителя — заказчику и диспетчерам; диспетчера — заказчику и исполнителю.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/messages`, { body: 'Нужен доступ в квартиру' })).status, 201);
  assert.deepEqual(await fresh(owner), ['Новое сообщение по заявке']);
  assert.deepEqual(await fresh(dispatcher), ['Новое сообщение по заявке']);
  assert.deepEqual(await fresh(spec), []);
  await fresh(dispatcher2);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/messages`, { body: 'Передал' })).status, 201);
  assert.deepEqual(await fresh(dispatcher2), [], 'сообщение диспетчера другим диспетчерам не рассылается');
  assert.deepEqual(await fresh(spec), ['Новое сообщение по заявке']);
  await fresh(owner);

  await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } });
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review', 'in_work')).status, 200);
  assert.deepEqual(await fresh(dispatcher), ['Результат сдан на проверку']);
  assert.equal((await step(dispatcher, o, 'in_work', 'review', 'Нет расчёта')).status, 200);
  assert.deepEqual(await fresh(spec), ['Результат возвращён на доработку']);
  assert.deepEqual(await fresh(owner), [], 'доработка — дело исполнителя и диспетчера');
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review', 'in_work')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  // Результат проверен и выдан — заказчику «доступен», исполнителю «принят» и сразу «выплачено» (1.6а).
  assert.equal((await step(dispatcher, o, 'done', 'review')).status, 200);
  assert.deepEqual(await fresh(owner), ['Результат проверен и доступен в кабинете']);
  assert.deepEqual(await fresh(spec), ['Результат принят проверкой', 'Вознаграждение выплачено']);
  assert.equal((await step(owner, o, 'closed', 'done')).status, 200);
  assert.deepEqual(await fresh(spec), ['Заявка закрыта']);

  // Ссылка из уведомления ведёт в заявку; непрочитанные считаются в /api/me.
  const list = (await owner.req('GET', '/api/notifications')).body;
  assert.equal(list.notifications[0].order_id, o.id);
  assert.equal(list.notifications[0].order_title, TITLE);
  assert.ok(list.unread >= 4);
  assert.equal((await owner.req('GET', '/api/me')).body.unread_notifications, list.unread);
  assert.equal((await owner.req('POST', '/api/notifications/read', { all: true })).body.unread, 0);
  assert.equal((await owner.req('GET', '/api/me')).body.unread_notifications, 0);
});

test('отмены: диспетчер отменил — заказчику и исполнителю; заказчик отменил — диспетчерам и исполнителю', async () => {
  for (const c of [owner, dispatcher, spec]) await fresh(c);
  const a = await submitted();
  assert.equal((await offer(a, spec)).status, 200);
  await fresh(spec); await fresh(dispatcher);
  assert.equal((await step(dispatcher, a, 'cancelled', 'awaiting_executor', 'Заказчик передумал')).status, 200);
  assert.deepEqual(await fresh(owner), ['Диспетчер отменил заявку', 'Деньги по заявке возвращены']);
  assert.deepEqual(await fresh(spec), ['Дело отменено']);

  const b = await submitted();
  assert.equal((await offer(b, spec)).status, 200);
  await fresh(spec); await fresh(dispatcher);
  assert.equal((await step(owner, b, 'cancelled', 'awaiting_executor')).status, 200);
  assert.deepEqual(await fresh(dispatcher), ['Заказчик отменил заявку']);
  assert.deepEqual(await fresh(spec), ['Дело отменено']);
  assert.deepEqual(await fresh(owner), ['Деньги по заявке возвращены'], 'возврат приходит и тому, кто отменил сам');

  // Передача другому исполнителю (1.6а): прежнему — «передано другому», заказчику — «передана другому исполнителю».
  const d = await submitted();
  assert.equal((await offer(d, spec)).status, 200);
  assert.equal((await step(spec, d, 'in_work', 'awaiting_executor')).status, 200);
  await fresh(spec); await fresh(owner);
  assert.equal((await step(dispatcher, d, 'matching', 'in_work', 'Исполнитель не выходит на связь')).status, 200);
  assert.deepEqual(await fresh(spec), ['Дело передано другому исполнителю']);
  assert.deepEqual(await fresh(owner), ['Заявка передана другому исполнителю']);

  // Возврат не прошёл — заказчику и диспетчерам; диспетчер повторяет.
  await fresh(dispatcher);
  S.providers.payments.refundOutcome = 'failed';
  try {
    assert.equal((await step(dispatcher, d, 'cancelled', 'matching', 'Заказчик не хочет ждать')).status, 200);
  } finally { S.providers.payments.refundOutcome = 'succeeded'; }
  assert.deepEqual(await fresh(owner), ['Диспетчер отменил заявку', 'Возврат денег не прошёл — диспетчер повторит']);
  assert.deepEqual(await fresh(dispatcher), ['Возврат заказчику не прошёл — нужен повтор']);
  assert.equal((await dispatcher.req('POST', `/api/orders/${d.id}/refund/retry`)).status, 200);
  assert.deepEqual(await fresh(owner), ['Деньги по заявке возвращены']);

  // Отмена новой (не отправленной) заявки никого не беспокоит.
  const c = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  assert.equal((await step(owner, c, 'cancelled', 'new')).status, 200);
  assert.deepEqual(await fresh(dispatcher), []);
});

test('СМС: по настройкам вида, без названия заявки и персональных данных, только номер заявки', async () => {
  await fresh(spec);
  S.providers.sms.reset();
  const o = await submitted();
  // Очередь диспетчера по умолчанию без СМС — в кабинете есть, СМС нет.
  assert.deepEqual(smsTo(dispatcher), []);
  assert.equal((await offer(o, spec)).status, 200);
  const texts = smsTo(spec);
  assert.equal(texts.length, 1);
  const ref = `№ ${o.id.slice(0, 8).toUpperCase()}`;
  assert.equal(texts[0], `БЕРТЕЛ Дело: Вам предложено новое дело. Заявка ${ref}. Подробности — в кабинете.`);
  assert.ok(!texts[0].includes('Иванов') && !texts[0].includes('Тайная'), 'ни имени, ни адреса');
  const d = await S.sql`select status, attempts from notification_deliveries where phone = ${spec.user.phone} and body = ${texts[0]}`;
  assert.deepEqual(d.map((x) => [x.status, x.attempts]), [['sent', 1]]);

  // Специалист выключил СМС о предложениях — в кабинете уведомление есть, СМС нет.
  assert.equal((await spec.req('PUT', '/api/notifications/settings', { type: 'offers', sms: false })).status, 200);
  assert.equal((await step(spec, o, 'matching', 'awaiting_executor', 'В отпуске')).status, 200);
  assert.equal((await offer(o, spec)).status, 200);
  assert.deepEqual(await fresh(spec), ['Вам предложено новое дело', 'Вам предложено новое дело']);
  assert.equal(smsTo(spec).length, 1);
  // Диспетчер включил СМС очереди — получает.
  assert.equal((await dispatcher.req('PUT', '/api/notifications/settings', { type: 'dispatch', sms: true })).status, 200);
  assert.equal((await step(spec, o, 'matching', 'awaiting_executor', 'Всё же нет')).status, 200);
  assert.deepEqual(smsTo(dispatcher), [`БЕРТЕЛ Дело: Исполнитель отказался от дела — нужен новый подбор. Заявка ${ref}. Подробности — в кабинете.`]);
  assert.equal(smsTo(dispatcher2).length, 0);
  await dispatcher.req('PUT', '/api/notifications/settings', { type: 'dispatch', sms: false });
  await spec.req('PUT', '/api/notifications/settings', { type: 'offers', sms: true });
});

test('СМС не ушло — действие всё равно выполнено; повтор позже; после пяти неудач — «не отправлено»', async () => {
  const o = await submitted();
  S.providers.sms.script({ kind: 'fail', message: 'нет связи' });
  try {
    assert.equal((await offer(o, spec)).status, 200, 'отказ СМС не мешает предложить дело');
  } finally { S.providers.sms.script({ kind: 'ok' }); }
  const [row] = await S.sql`select * from notification_deliveries where phone = ${spec.user.phone} order by id desc limit 1`;
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.error, 'нет связи');
  // Раньше времени повтора не отправляется.
  assert.equal((await deliverPending(S.sql, S.providers)).claimed, 0);
  await S.sql`update notification_deliveries set next_at = now() where id = ${row.id}`;
  assert.deepEqual(await deliverPending(S.sql, S.providers), { claimed: 1, sent: 1 });
  assert.equal((await S.sql`select status from notification_deliveries where id = ${row.id}`)[0].status, 'sent');

  // Пять неудач подряд — строка «не отправлено», больше не повторяется.
  await S.sql`insert into notification_deliveries (channel, phone, body) values ('sms', '+79990000799', 'проверка')`;
  S.providers.sms.script({ kind: 'fail', message: 'нет связи' });
  try {
    for (let i = 0; i < DELIVERY.maxAttempts; i++) {
      await S.sql`update notification_deliveries set next_at = now() where phone = '+79990000799'`;
      await deliverPending(S.sql, S.providers);
    }
  } finally { S.providers.sms.script({ kind: 'ok' }); }
  await S.sql`update notification_deliveries set next_at = now() where phone = '+79990000799'`;
  assert.equal((await deliverPending(S.sql, S.providers)).claimed, 0);
  const [dead] = await S.sql`select status, attempts from notification_deliveries where phone = '+79990000799'`;
  assert.deepEqual([dead.status, dead.attempts], ['failed', DELIVERY.maxAttempts]);
});

test('две копии сервера не отправят одну СМС дважды', async () => {
  await S.sql`insert into notification_deliveries (channel, phone, body)
              select 'sms', '+79990000798', 'проверка ' || g from generate_series(1, 30) g`;
  const before = S.providers.sms.calls.filter((x) => x.method === 'send' && x.args.phone === '+79990000798').length;
  const [a, b] = await Promise.all([deliverPending(S.sql, S.providers, { limit: 30 }), deliverPending(S.sql, S.providers, { limit: 30 })]);
  assert.equal(a.sent + b.sent, 30);
  const after = S.providers.sms.calls.filter((x) => x.method === 'send' && x.args.phone === '+79990000798').length;
  assert.equal(after - before, 30);
});

test('неудавшаяся выплата: исполнителю и диспетчерам; отключённый пользователь уведомлений не получает', async () => {
  await fresh(spec); await fresh(dispatcher); await fresh(dispatcher2);
  const o = await submitted();
  await fresh(dispatcher); await fresh(dispatcher2);
  assert.equal((await offer(o, spec)).status, 200);
  await step(spec, o, 'in_work', 'awaiting_executor');
  await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } });
  await signResults(S, spec, o.id);
  await step(spec, o, 'review', 'in_work');
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  // Второй диспетчер отключён — ему ничего не пишется.
  await S.sql`update users set is_active = false where id = ${dispatcher2.user.id}`;
  await fresh(spec); await fresh(dispatcher);
  S.providers.payments.payoutOutcome = 'failed';
  try {
    assert.equal((await step(dispatcher, o, 'done', 'review')).status, 200, 'сбой выплаты не мешает выдать результат');
  } finally { S.providers.payments.payoutOutcome = 'succeeded'; }
  assert.deepEqual(await fresh(spec), ['Результат принят проверкой', 'Выплата вознаграждения не прошла — диспетчер повторит']);
  assert.deepEqual(await fresh(dispatcher), ['Выплата исполнителю не прошла — нужен повтор']);
  const n = await S.sql`select event from notifications where user_id = ${dispatcher2.user.id} and order_id = ${o.id} order by id`;
  assert.deepEqual(n.map((x) => x.event), ['submitted', 'in_review'], 'после отключения — ничего');
  await S.sql`update users set is_active = true where id = ${dispatcher2.user.id}`;
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payout/retry`)).status, 200);
  assert.deepEqual(await fresh(spec), ['Вознаграждение выплачено']);
});

test('приглашение в организацию: с учётной записью — в кабинет и СМС; без неё — только СМС; ответ одинаковый', async () => {
  const head = await login(S, '+79990000711');
  const org = await makeOrg(S.sql, 'Тестовая организация уведомлений');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const known = await login(S, '+79990000712');
  const r1 = await head.req('POST', `/api/orgs/${org.id}/invites`, { phone: '+79990000712' });
  const r2 = await head.req('POST', `/api/orgs/${org.id}/invites`, { phone: '+79990000713' });
  assert.deepEqual([r1.status, r2.status], [201, 201]);
  assert.deepEqual(Object.keys(r1.body.invite).sort(), Object.keys(r2.body.invite).sort());
  assert.deepEqual(await fresh(known), ['Вас пригласили в организацию']);
  const text = 'БЕРТЕЛ Дело: Вас пригласили в организацию. Войдите по этому номеру телефона, чтобы ответить.';
  assert.deepEqual(smsTo(known), [text]);
  const unknown = S.providers.sms.calls.filter((x) => x.method === 'send' && x.args.phone === '+79990000713').map((x) => x.args.text);
  assert.deepEqual(unknown, [text]);
  assert.equal((await S.sql`select count(*)::int as n from users where phone = '+79990000713'`)[0].n, 0, 'учётная запись не заводится');
});

test('все виды уведомлений (2.45): каждое событие где-то наступает, у каждого вида есть события, без заявки — ведёт в раздел', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.mjs') && !p.endsWith('registry.mjs')) files.push(fs.readFileSync(p, 'utf8')); } };
  walk('src');
  const code = files.join('\n');
  for (const id of Object.keys(EVENTS)) assert.match(code, new RegExp(`['"\`]${id}['"\`]`), `событие «${id}» нигде не наступает`);
  for (const t of TYPES) assert.ok(Object.values(EVENTS).some((e) => e.type === t.id), `у вида «${t.id}» нет событий`);
  for (const [id, e] of Object.entries(EVENTS)) if (!e.order) assert.ok(e.section, `«${id}»: без заявки и без раздела`);
  assert.throws(() => validateRegistry(TYPES, { ...EVENTS, x_test: { type: 'money', title: 'Без заявки и раздела' } }), /укажите раздел/);

  // Ссылка из уведомления без заявки: по организации — сразу в неё; досье — «Специалист»; истёкший документ эксперта у
  // диспетчера — «Специалисты».
  const head = await login(S, '+79990000731');
  const org = await makeOrg(S.sql, 'Тестовое бюро уведомлений');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await S.sql`insert into notifications (user_id, type, event, org_id) values (${head.user.id}, 'executor_work', 'org_sign_needed', ${org.id}),
              (${head.user.id}, 'org_cases', 'org_offer', ${org.id}), (${head.user.id}, 'executor_work', 'dossier_week', null)`;
  const list = (await head.req('GET', '/api/notifications')).body.notifications;
  assert.deepEqual(list.map((n) => n.section), ['specialist', `org=${org.id}`, `org=${org.id}`]);
  // Ушёл из организации — ссылка на неё не даётся.
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${head.user.id}`;
  assert.deepEqual((await head.req('GET', '/api/notifications')).body.notifications.map((n) => n.section), ['specialist', 'orgs', 'orgs']);
  await S.sql`insert into notifications (user_id, type, event) values (${dispatcher.user.id}, 'dispatch', 'dossier_expired_staff')`;
  assert.equal((await dispatcher.req('GET', '/api/notifications')).body.notifications[0].section, 'specialists');
});

test('лишних уведомлений нет (2.45): один человек — одна строка на событие, даже если он подходит по двум признакам', async () => {
  // Руководитель организации-заказчика, который сам создал заявку и одновременно диспетчер, получает «цена назначена»
  // один раз, а своё же действие — не получает.
  const both = await login(S, '+79990000732');
  await setPlatformRole(S.sql, both.user.id, 'dispatcher');
  const org = await makeOrg(S.sql, 'Тестовая фирма уведомлений');
  await addMember(S.sql, org.id, both.user.id, 'head');
  const o = (await both.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Своя заявка диспетчера', org_id: org.id })).body.order;
  assert.equal((await both.req('PATCH', `/api/orders/${o.id}`, READY)).status, 200);
  assert.equal((await step(both, o, 'matching', 'new')).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '9000' })).status, 200);
  const rows = await S.sql`select event, count(*)::int as n from notifications where user_id = ${both.user.id} and order_id = ${o.id} group by event order by event`;
  assert.deepEqual(rows.map((r) => [r.event, r.n]), [['priced', 1]], 'своя отправка — без уведомления, цена — одна строка');
  // Во всех заявках этого файла: одно действие (одна транзакция — одно время now()) не даёт человеку две одинаковые строки.
  const dup = await S.sql`select user_id, event, order_id, count(*)::int as n from notifications
                          group by user_id, event, order_id, created_at having count(*) > 1`;
  assert.deepEqual(dup, [], 'нет двойных уведомлений от одного действия');
});
