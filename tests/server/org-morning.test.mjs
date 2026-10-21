// Утренняя сводка руководителю «На сегодня по организации» (2.121): раз в день после 8:00 по Москве — одно уведомление на
// организацию: сколько дел ждут подписи организации, просьб экспертов передать дело, дел экспертов со сроком сегодня и с
// прошедшим сроком. Нечего сообщить — не приходит. В ленте и СМС — только цифры (организация — строкой ниже в ленте);
// ведёт в организацию. Чужая организация и не руководитель — ничего.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { digestText, morningTo, orgDigestText, orgDigestTo, sendOrgMorning } from '../../src/notify/morning.mjs';

let S, owner, dispatcher, spec, head, head2, idleHead, org, idleOrg;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Руководящая ул., 21', area: '40' };
const today = todayMsk();
const tomorrow = addDays(today, 1);
const at = (day, time) => new Date(`${day}T${time}:00+03:00`);

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990003801');
  dispatcher = await login(S, '+79990003802');
  spec = await login(S, '+79990003803');
  head = await login(S, '+79990003804');
  head2 = await login(S, '+79990003805');
  idleHead = await login(S, '+79990003806');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Утренняя оценка»');
  idleOrg = await makeOrg(S.sql, 'ООО «Тихая оценка»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, head2.user.id, 'head');
  await addMember(S.sql, idleOrg.id, idleHead.user.id, 'head');
  await makeSpecialist(S.sql, spec.user.id);
  await addMember(S.sql, org.id, spec.user.id, 'member');
  await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Утренний' });
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
});
after(async () => { await S?.close(); });

async function inWork(title, deadline) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 9), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  await S.sql`update orders set deadline = ${deadline}::date where id = ${o.id}`;
  return o;
}
const mine = async (userId) => S.sql`select id from notifications where user_id = ${userId} and event = 'org_morning_today' order by id`;

test('текст сводки руководителя: только непустые части, склонения', () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, due: 0, overdue: 0 }), null);
  assert.equal(orgDigestText({ sign: 1, handover: 0, due: 0, overdue: 0 }), 'На сегодня по организации: 1 дело ждёт подписи организации');
  assert.equal(orgDigestText({ sign: 2, handover: 1, due: 5, overdue: 1 }),
    'На сегодня по организации: 2 дела ждут подписи организации, 1 просьба передать дело, у экспертов сдать сегодня 5 дел, 1 дело с прошедшим сроком');
  assert.equal(orgDigestText({ sign: 11, handover: 3, due: 21, overdue: 12 }),
    'На сегодня по организации: 11 дел ждут подписи организации, 3 просьбы передать дело, у экспертов сдать сегодня 21 дело, 12 дел с прошедшим сроком');
});

test('после 8:00 — одна сводка каждому руководителю с цифрами организации; до 8:00, повторно и без дел — ничего', async () => {
  const due = await inWork('Квартира на Руководящей — сдать сегодня', today);
  await inWork('Дом с прошедшим сроком', addDays(today, -2));
  await inWork('Срок через неделю', addDays(today, 7));
  // Эксперт подписал файл результата — ждёт подписи организации; по другому делу просит передать его коллеге.
  const d = (await spec.req('POST', `/api/orders/${due.id}/results`, Buffer.from('отчёт'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт.pdf') },
  })).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  const away = await inWork('Отпускное дело', addDays(today, 5));
  assert.equal((await spec.req('POST', `/api/orders/${away.id}/handover`, { reason: 'Отпуск' })).status, 201);

  assert.equal(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '07:59') }), 0);
  assert.equal((await S.sql`select count(*)::int as n from org_morning_digests`)[0].n, 0);

  assert.equal(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '09:00') }), 2);
  const [r] = await S.sql`select sign, handover, due, overdue from org_morning_digests where user_id = ${head.user.id} and org_id = ${org.id}`;
  assert.deepEqual({ ...r }, { sign: 1, handover: 1, due: 1, overdue: 1 });
  assert.equal((await mine(head.user.id)).length, 1);
  assert.equal((await mine(head2.user.id)).length, 1);
  // Эксперт — не руководитель: сводки по организации нет. Тихая организация — день посчитан, уведомления нет.
  assert.equal((await mine(spec.user.id)).length, 0);
  assert.equal((await mine(idleHead.user.id)).length, 0);
  assert.equal((await S.sql`select count(*)::int as n from org_morning_digests where user_id = ${idleHead.user.id} and notification_id is null`)[0].n, 1);
  assert.equal(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '09:05') }), 0);

  // В ленте — цифры (организация — отдельно), ведёт в организацию — сразу к делам со сроком (2.130); названия дел и адреса
  // нигде не звучат.
  const feed = (await head.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 1 дело ждёт подписи организации, 1 просьба передать дело (передать некому: 1), у экспертов сдать сегодня 1 дело, 1 дело с прошедшим сроком');
  assert.deepEqual([feed[0].section, feed[0].order_id, feed[0].order_ref], [`org=${org.id}&to=week`, null, null]);
  const [sms] = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                            where n.user_id = ${head.user.id} and n.event = 'org_morning_today'`;
  assert.equal(sms.body, `БЕРТЕЛ Дело: ${feed[0].title}. Подробно — «Дела экспертов» в кабинете.`);
  assert.doesNotMatch(sms.body, /Утренн|Квартира|Москва|Отпуск|Эксперт Утренний/);
  assert.doesNotMatch(JSON.stringify(feed), /Квартира|Руководящ|Эксперт Утренний/);
});

test('вид в настройках — только у руководителя; СМС выключается отдельно; ушедший из руководителей — ничего', async () => {
  const types = (await head.req('GET', '/api/notifications/settings')).body.settings.map((t) => t.type);
  assert.ok(types.includes('org_morning'));
  for (const c of [spec, owner]) assert.ok(!(await c.req('GET', '/api/notifications/settings')).body.settings.some((t) => t.type === 'org_morning'));
  assert.equal((await head.req('PUT', '/api/notifications/settings', { type: 'org_morning', sms: false })).status, 200);
  await S.sql`update org_members set role = 'member' where org_id = ${org.id} and user_id = ${head2.user.id}`;
  // Назавтра: «сдать сегодня» стало с прошедшим сроком — сводка снова, но без СМС; бывшему руководителю — нет.
  assert.equal(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(tomorrow, '08:01') }), 1);
  const [d] = await S.sql`select due, overdue, notification_id from org_morning_digests where user_id = ${head.user.id} and day = ${tomorrow}::date`;
  assert.deepEqual([d.due, d.overdue], [0, 2]);
  assert.equal((await S.sql`select count(*)::int as n from notification_deliveries where notification_id = ${d.notification_id}`)[0].n, 0);
  assert.equal((await S.sql`select count(*)::int as n from org_morning_digests where user_id = ${head2.user.id} and day = ${tomorrow}::date`)[0].n, 0);
});

test('куда ведёт сводка (2.130): сроки — к отбору «Срок на этой неделе», иначе к подписи, иначе к просьбам передать', () => {
  assert.equal(orgDigestTo({ sign: 2, handover: 1, due: 1, overdue: 1 }), 'week');
  // 2.158: сегодня сроков нет, только прошедшие — к отбору «Срок прошёл».
  assert.equal(orgDigestTo({ sign: 2, handover: 1, due: 0, overdue: 1 }), 'overdue');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 1, overdue: 0 }), 'week');
  assert.equal(orgDigestTo({ sign: 1, handover: 1, due: 0, overdue: 0 }), 'sign');
  assert.equal(orgDigestTo({ sign: 0, handover: 2, due: 0, overdue: 0 }), 'handover');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0 }), null);
});

test('без движения (2.141): число дел без движения 3 дня и больше — в тексте; больше ничего нет — к отбору «Без движения»', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 1 }), 'На сегодня по организации: 1 дело без движения 3 дня и больше');
  assert.equal(orgDigestText({ sign: 1, handover: 0, due: 0, overdue: 2, idle: 5 }),
    'На сегодня по организации: 1 дело ждёт подписи организации, 2 дела с прошедшим сроком, 5 дел без движения 3 дня и больше');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 2 }), 'idle');
  assert.equal(orgDigestTo({ sign: 0, handover: 1, due: 0, overdue: 0, idle: 2 }), 'handover');
  assert.equal(orgDigestTo({ sign: 1, handover: 0, due: 0, overdue: 0, idle: 2 }), 'sign');

  // Отдельная организация: у эксперта два дела в работе со сроком через неделю; по одному ничего не происходит 5 дней,
  // заказчик при этом пишет (переписка движением не считается), по другому — эксперт только что принял дело.
  const h = await login(S, '+79990003807');
  const e = await login(S, '+79990003808');
  const o2 = await makeOrg(S.sql, 'ООО «Неподвижная оценка»');
  await addMember(S.sql, o2.id, h.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o2.id, e.user.id, 'member');
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o2.id })).status, 200);
  const day3 = addDays(today, 3);
  const make = async (title) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 12), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: e.user.id, from: 'matching' })).status, 200);
    assert.equal((await e.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    return o;
  };
  const still = await make('Неподвижное дело');
  await make('Свежее дело');
  await S.sql`update order_status_history set at = now() - interval '5 days' where order_id = ${still.id}`;
  await S.sql`update orders set updated_at = now() - interval '5 days' where id = ${still.id}`;
  assert.equal((await owner.req('POST', `/api/orders/${still.id}/messages`, { body: 'Как продвигается?' })).status, 201);

  // Через три дня утром: «Неподвижное» без движения 8 дней, «Свежее» — 3 дня (тоже без движения); сроки не горят.
  await S.sql`update order_status_history set at = at - interval '3 days' where order_id in
              (select id from orders where executor_user_id = ${e.user.id})`;
  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(day3, '08:30') }) >= 1);
  const [r] = await S.sql`select sign, handover, due, overdue, idle from org_morning_digests where user_id = ${h.user.id} and org_id = ${o2.id}`;
  assert.deepEqual({ ...r }, { sign: 0, handover: 0, due: 0, overdue: 0, idle: 2 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 2 дела без движения 3 дня и больше');
  assert.equal(feed[0].section, `org=${o2.id}&to=idle`);
  assert.doesNotMatch(JSON.stringify(feed), /Неподвижное|Свежее|Как продвигается/);
});

test('прогон 2.150: эксперт подписал, файл ждёт подписи организации — дело не «без движения» ни в сводке, ни в делах, ни в карточке', async () => {
  const h = await login(S, '+79990003809');
  const e = await login(S, '+79990003810');
  const o3 = await makeOrg(S.sql, 'ООО «Подписная оценка»');
  await addMember(S.sql, o3.id, h.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o3.id, e.user.id, 'member');
  await e.req('PATCH', '/api/me', { full_name: 'Эксперт Подписной' });
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o3.id })).status, 200);
  const make = async (title) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 12), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: e.user.id, from: 'matching' })).status, 200);
    assert.equal((await e.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    return o;
  };
  const signed = await make('Подписано экспертом');
  const still = await make('Стоит без файла');
  const d = (await e.req('POST', `/api/orders/${signed.id}/results`, Buffer.from('отчёт'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт.pdf') },
  })).body.document;
  assert.equal((await e.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  // Пять дней ничего не происходит по обоим делам.
  const ids = [signed.id, still.id];
  await S.sql`update order_status_history set at = at - interval '5 days' where order_id = any(${ids}::uuid[])`;
  await S.sql`update documents set created_at = created_at - interval '5 days' where order_id = any(${ids}::uuid[])`;
  await S.sql`update document_signatures set signed_at = signed_at - interval '5 days' where order_id = any(${ids}::uuid[])`;
  await S.sql`update orders set updated_at = now() - interval '5 days' where id = any(${ids}::uuid[])`;

  const cases = (await h.req('GET', `/api/orgs/${o3.id}/cases`)).body.cases;
  const byId = new Map(cases.map((c) => [c.id, c]));
  assert.equal(byId.get(signed.id).sign_wait, 1);
  assert.equal(byId.get(signed.id).idle, false, 'ход за руководителем — не «без движения» у эксперта');
  assert.equal(byId.get(signed.id).last_move.days, 5);
  assert.equal(byId.get(still.id).idle, true);

  const card = (await h.req('GET', `/api/specialists/${e.user.id}/card`)).body;
  assert.deepEqual(card.now.cases.map((x) => x.idle).sort(), [false, true]);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 1);
  const [r] = await S.sql`select sign, idle from org_morning_digests where user_id = ${h.user.id} and org_id = ${o3.id}`;
  assert.deepEqual({ ...r }, { sign: 1, idle: 1 });

  // Руководитель вернул файл с замечаниями: подпись эксперта снята, но возврат — свежее движение, дело не «стоит 5 дней».
  assert.equal((await h.req('POST', `/api/org-documents/${d.id}/return`, { comment: '1. Итог не совпадает с таблицей' })).status, 201);
  const back = (await h.req('GET', `/api/orgs/${o3.id}/cases`)).body.cases.find((c) => c.id === signed.id);
  assert.equal(back.sign_wait, 0);
  assert.equal(back.idle, false);
  assert.equal(back.last_move.days, 0);
});

test('вернул эксперту (2.153): число дел, где возврат не исправлен 2 дня и больше, — в тексте; больше ничего нет — к отбору «Вернул эксперту»', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 1 }),
    'На сегодня по организации: 1 дело после возврата эксперту не исправлено 2 дня и больше');
  assert.equal(orgDigestText({ sign: 1, handover: 0, due: 0, overdue: 0, idle: 3, returned: 2 }),
    'На сегодня по организации: 1 дело ждёт подписи организации, 3 дела без движения 3 дня и больше, 2 дела после возврата эксперту не исправлены 2 дня и больше');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 2, returned: 1 }), 'returned');
  assert.equal(orgDigestTo({ sign: 0, handover: 1, due: 0, overdue: 0, idle: 0, returned: 1 }), 'handover');

  // Отдельная организация: у эксперта три дела. По «Давнему» руководитель вернул отчёт 3 дня назад, эксперт не исправил;
  // по «Свежему» — вернул только что; по «Исправленному» вернул 3 дня назад, эксперт подписал заново (ждёт подписи).
  const h = await login(S, '+79990003811');
  const e = await login(S, '+79990003812');
  const o4 = await makeOrg(S.sql, 'ООО «Возвратная оценка»');
  await addMember(S.sql, o4.id, h.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o4.id, e.user.id, 'member');
  await e.req('PATCH', '/api/me', { full_name: 'Эксперт Возвратный' });
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o4.id })).status, 200);
  const make = async (title) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 12), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: e.user.id, from: 'matching' })).status, 200);
    assert.equal((await e.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    const d = (await e.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`отчёт ${title}`), {
      raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт.pdf') },
    })).body.document;
    assert.equal((await e.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
    assert.equal((await h.req('POST', `/api/org-documents/${d.id}/return`, { comment: '1. Нет даты осмотра\n2. Не указан этаж' })).status, 201);
    return { o, d };
  };
  const old = await make('Давнее');
  await make('Свежее');
  const fixed = await make('Исправленное');
  await S.sql`update org_returns set created_at = now() - interval '3 days' where order_id = any(${[old.o.id, fixed.o.id]}::uuid[])`;
  assert.equal((await e.req('POST', `/api/documents/${fixed.d.id}/sign`, { confirm: true })).status, 201);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 1);
  const [r] = await S.sql`select sign, handover, due, overdue, idle, returned from org_morning_digests where user_id = ${h.user.id} and org_id = ${o4.id}`;
  assert.deepEqual({ ...r }, { sign: 1, handover: 0, due: 0, overdue: 0, idle: 0, returned: 1 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 1 дело ждёт подписи организации, 1 дело после возврата эксперту не исправлено 2 дня и больше');
  assert.equal(feed[0].section, `org=${o4.id}&to=sign`);
  assert.doesNotMatch(JSON.stringify(feed), /Давнее|Свежее|Нет даты осмотра/);
  // Подписи ждать уже нечего — сводка ведёт к отбору «Вернул эксперту».
  assert.equal(orgDigestTo({ ...r, sign: 0 }), 'returned');
});

test('исправленный файл не подписан (2.172): число дел, где после возврата эксперт загрузил исправленный файл и не подписал 2 дня и больше; больше ничего нет — к отбору «Исправленный файл ждёт подписи эксперта»', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 1 }),
    'На сегодня по организации: 1 дело — исправленный файл не подписан экспертом 2 дня и больше');
  assert.equal(orgDigestText({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 1, fresh: 3 }),
    'На сегодня по организации: 1 дело после возврата эксперту не исправлено 2 дня и больше, 3 дела — исправленный файл не подписан экспертом 2 дня и больше');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 2, returned: 0, fresh: 1 }), 'fresh');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 1, fresh: 1 }), 'returned');

  // Своя организация: у эксперта три возвращённых дела. По «Старому файлу» эксперт удалил возвращённый файл и 3 дня назад
  // загрузил исправленный, не подписал; по «Новому файлу» — загрузил только что; по «Без файла» — удалил и ничего не загрузил
  // (возврат 3 дня назад — это «не исправлено», не «не подписан»).
  const h = await login(S, '+79990003821');
  const e = await login(S, '+79990003822');
  const o5 = await makeOrg(S.sql, 'ООО «Исправленная оценка»');
  await addMember(S.sql, o5.id, h.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o5.id, e.user.id, 'member');
  await e.req('PATCH', '/api/me', { full_name: 'Эксперт Исправленный' });
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o5.id })).status, 200);
  const upload = async (o, name) => (await e.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`отчёт ${name}`), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
  })).body.document;
  const make = async (title) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 12), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: e.user.id, from: 'matching' })).status, 200);
    assert.equal((await e.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    const d = await upload(o, 'Отчёт.pdf');
    assert.equal((await e.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
    assert.equal((await h.req('POST', `/api/org-documents/${d.id}/return`, { comment: 'Нет даты осмотра' })).status, 201);
    assert.equal((await e.req('DELETE', `/api/documents/${d.id}`)).status, 204);
    return o;
  };
  const old = await make('Старый файл');
  const fresh = await make('Новый файл');
  const none = await make('Без файла');
  await S.sql`update org_returns set created_at = now() - interval '4 days' where order_id = any(${[old.id, fresh.id, none.id]}::uuid[])`;
  const oldDoc = await upload(old, 'Исправленный.pdf');
  await S.sql`update documents set created_at = now() - interval '3 days' where id = ${oldDoc.id}`;
  await upload(fresh, 'Исправленный.pdf');

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 1);
  const [r] = await S.sql`select sign, handover, due, overdue, idle, returned, fresh from org_morning_digests where user_id = ${h.user.id} and org_id = ${o5.id}`;
  assert.deepEqual({ ...r }, { sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 1, fresh: 1 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 1 дело после возврата эксперту не исправлено 2 дня и больше, 1 дело — исправленный файл не подписан экспертом 2 дня и больше');
  assert.equal(feed[0].section, `org=${o5.id}&to=returned`);
  assert.doesNotMatch(JSON.stringify(feed), /Старый файл|Новый файл|Исправленный\.pdf|Нет даты осмотра/);
  // «Не исправлено» уже нечего — сводка ведёт к отбору «Исправленный файл ждёт подписи эксперта».
  assert.equal(orgDigestTo({ ...r, returned: 0 }), 'fresh');
});

test('срок в дни, когда эксперт не принимает дела (2.209): число таких дел в работе — в тексте; о которых эксперт просит передать — не считаются; больше ничего нет — к отбору «Эксперт не принимает дела — срок в эти дни»', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 1 }),
    'На сегодня по организации: у 1 дела срок в дни, когда эксперт не принимает дела');
  assert.equal(orgDigestText({ sign: 0, handover: 1, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 5 }),
    'На сегодня по организации: 1 просьба передать дело, у 5 дел срок в дни, когда эксперт не принимает дела');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 2 }), 'away');
  assert.equal(orgDigestTo({ sign: 1, handover: 1, due: 0, overdue: 0, idle: 1, returned: 1, fresh: 1, away: 2 }), 'away');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 1, idle: 0, returned: 0, fresh: 0, away: 2 }), 'overdue');

  // Своя организация: эксперт не принимает дела 10 дней. «В отпуске» — срок через 5 дней (считается), «Позже отпуска» — срок
  // через 12 дней (не считается), «Просит передать» — срок через 4 дня, но эксперт уже просит передать (не повторяется).
  const h = await login(S, '+79990003831');
  const e = await login(S, '+79990003832');
  const o6 = await makeOrg(S.sql, 'ООО «Отпускная оценка»');
  await addMember(S.sql, o6.id, h.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o6.id, e.user.id, 'member');
  await e.req('PATCH', '/api/me', { full_name: 'Эксперт Отпускной' });
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o6.id })).status, 200);
  const make = async (title, days) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: e.user.id, from: 'matching' })).status, 200);
    assert.equal((await e.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    await S.sql`update orders set deadline = ${addDays(today, days)}::date where id = ${o.id}`;
    return o;
  };
  await make('В отпуске', 5);
  await make('Позже отпуска', 12);
  const asks = await make('Просит передать', 4);
  assert.equal((await e.req('POST', `/api/orders/${asks.id}/handover`, { reason: 'Буду в отпуске' })).status, 201);
  // Прогон 2.210: эксперт уже попросил перенести срок — руководителю тут делать нечего, в сводке не считается.
  const ext = await make('Просит перенос', 3);
  assert.equal((await e.req('POST', `/api/orders/${ext.id}/deadline-requests`, { new_deadline: addDays(today, 14), reason: 'В день срока меня не будет' })).status, 201);
  await S.sql`update specialists set away_until = ${addDays(today, 10)}::date, away_note = 'отпуск' where user_id = ${e.user.id}`;

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 1);
  const [r] = await S.sql`select sign, handover, due, overdue, idle, returned, fresh, away from org_morning_digests where user_id = ${h.user.id} and org_id = ${o6.id}`;
  assert.deepEqual({ ...r }, { sign: 0, handover: 1, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 1 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  // Эксперт в организации один — передать некому (2.228): сводка ведёт к отбору «Просят передать — передать некому».
  assert.equal(feed[0].title, 'На сегодня по организации: 1 просьба передать дело (передать некому: 1), у 1 дела срок в дни, когда эксперт не принимает дела');
  assert.equal(feed[0].section, `org=${o6.id}&to=stuck`);
  assert.doesNotMatch(JSON.stringify(feed), /В отпуске|Позже отпуска|Просит передать|Буду в отпуске|отпуск\b|Отпускной/);
  // Эксперту в «Делах экспертов» руководителя то же дело — с пометкой.
  const cases = (await h.req('GET', `/api/orgs/${o6.id}/cases`)).body.cases;
  assert.equal(cases.filter((c) => c.away && !c.handover).length, 2, 'в отборе — оба, у одного видна просьба о переносе');
});

test('просят передать, а передать некому (2.228): число таких просьб — в скобках у просьб передать дело; есть кому передать или уже просят перенос — не считаются; ведёт к отбору «Просят передать — передать некому»', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 1, stuck: 1, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0 }),
    'На сегодня по организации: 1 просьба передать дело (передать некому: 1)');
  assert.equal(orgDigestText({ sign: 0, handover: 3, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0 }),
    'На сегодня по организации: 3 просьбы передать дело');
  assert.equal(orgDigestTo({ sign: 1, handover: 1, stuck: 1, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 2 }), 'stuck');
  assert.equal(orgDigestTo({ sign: 0, handover: 2, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0 }), 'handover');
  assert.equal(orgDigestTo({ sign: 0, handover: 1, stuck: 1, due: 0, overdue: 1, idle: 0, returned: 0, fresh: 0, away: 0 }), 'overdue');

  // Одна организация — один эксперт: передать некому. «Некому» — просит передать (считается), «Уже перенос» — эксперт сам
  // попросил перенос, потом передать (не считается), «Руководитель попросил» — руководитель уже попросил диспетчера перенести
  // срок (просьба передать закрыта — не считается вовсе).
  const h = await login(S, '+79990003841');
  const e = await login(S, '+79990003842');
  const o7 = await makeOrg(S.sql, 'ООО «Одинокая оценка»');
  await addMember(S.sql, o7.id, h.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o7.id, e.user.id, 'member');
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o7.id })).status, 200);
  // Вторая организация — два эксперта: передать есть кому, просьба считается, «некому» — нет.
  const h2 = await login(S, '+79990003843');
  const a = await login(S, '+79990003844');
  const b = await login(S, '+79990003845');
  const o8 = await makeOrg(S.sql, 'ООО «Дружная оценка»');
  await addMember(S.sql, o8.id, h2.user.id, 'head');
  for (const x of [a, b]) {
    await makeSpecialist(S.sql, x.user.id);
    await addMember(S.sql, o8.id, x.user.id, 'member');
    assert.equal((await x.req('PATCH', '/api/specialist/me', { org_id: o8.id })).status, 200);
  }
  const make = async (who, title, days) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
    assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    await S.sql`update orders set deadline = ${addDays(today, days)}::date where id = ${o.id}`;
    return o;
  };
  const alone = await make(e, 'Дело без замены', 6);
  assert.equal((await e.req('POST', `/api/orders/${alone.id}/handover`, { reason: 'Заболел' })).status, 201);
  const asked = await make(e, 'Уже перенос', 7);
  assert.equal((await e.req('POST', `/api/orders/${asked.id}/deadline-requests`, { new_deadline: addDays(today, 14), reason: 'Заболел' })).status, 201);
  assert.equal((await e.req('POST', `/api/orders/${asked.id}/handover`, { reason: 'Заболел' })).status, 201);
  const byHead = await make(e, 'Руководитель попросил', 8);
  assert.equal((await e.req('POST', `/api/orders/${byHead.id}/handover`, { reason: 'Заболел' })).status, 201);
  assert.equal((await h.req('POST', `/api/orgs/${o7.id}/cases/${byHead.id}/handover/extend`,
    { new_deadline: addDays(today, 15), reason: 'Передать некому — просим перенести срок', from: addDays(today, 8) })).status, 201);
  const mates = await make(a, 'Есть кому', 6);
  assert.equal((await a.req('POST', `/api/orders/${mates.id}/handover`, { reason: 'Заболел' })).status, 201);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 2);
  const [r] = await S.sql`select handover, stuck from org_morning_digests where user_id = ${h.user.id} and org_id = ${o7.id}`;
  assert.deepEqual({ ...r }, { handover: 2, stuck: 1 });
  const [r2] = await S.sql`select handover, stuck from org_morning_digests where user_id = ${h2.user.id} and org_id = ${o8.id}`;
  assert.deepEqual({ ...r2 }, { handover: 1, stuck: 0 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.match(feed[0].title, /^На сегодня по организации: 2 просьбы передать дело \(передать некому: 1\)/);
  assert.equal(feed[0].section, `org=${o7.id}&to=stuck`);
  assert.doesNotMatch(JSON.stringify(feed), /Дело без замены|Уже перенос|Заболел/);
  const feed2 = (await h2.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed2[0].section, `org=${o8.id}&to=handover`);
  // В «Делах экспертов» — те же дела под отбор: просит передать, передать некому, перенос не просят.
  const cases = (await h.req('GET', `/api/orgs/${o7.id}/cases`)).body.cases;
  assert.deepEqual(cases.filter((c) => c.handover && !c.transfer_to.length && !c.extend).map((c) => c.id), [alone.id]);
});

// 2.238: руководитель попросил диспетчера перенести срок от организации (2.221) — в «Делах экспертов» у дела видно, ждём ли
// ответа, отказал ли диспетчер (с пояснением) или согласился; отбор — ждём ответа и отказано. Отказы за сутки — в утренней сводке.
test('2.238: перенос от организации — ждём ответа / отказано / согласовано в «Делах экспертов», отказы — в утренней сводке', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 2 }),
    'На сегодня по организации: диспетчер отказал в переносе срока по просьбе организации: 2');
  assert.equal(orgDigestTo({ sign: 1, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 1, ext_declined: 1 }), 'orgext');
  assert.equal(orgDigestTo({ sign: 0, handover: 1, stuck: 1, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 1 }), 'stuck');

  const h = await login(S, '+79990003851');
  const e = await login(S, '+79990003852');
  const other = await login(S, '+79990003853');
  const o9 = await makeOrg(S.sql, 'ООО «Срочная оценка»');
  const oX = await makeOrg(S.sql, 'ООО «Чужая оценка»');
  await addMember(S.sql, o9.id, h.user.id, 'head');
  await addMember(S.sql, oX.id, other.user.id, 'head');
  await makeSpecialist(S.sql, e.user.id);
  await addMember(S.sql, o9.id, e.user.id, 'member');
  assert.equal((await e.req('PATCH', '/api/specialist/me', { org_id: o9.id })).status, 200);
  const make = async (title, days) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: e.user.id, from: 'matching' })).status, 200);
    assert.equal((await e.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    await S.sql`update orders set deadline = ${addDays(today, days)}::date where id = ${o.id}`;
    assert.equal((await e.req('POST', `/api/orders/${o.id}/handover`, { reason: 'Заболел' })).status, 201);
    assert.equal((await h.req('POST', `/api/orgs/${o9.id}/cases/${o.id}/handover/extend`,
      { new_deadline: addDays(today, days + 7), reason: 'Передать некому — просим перенести срок', from: addDays(today, days) })).status, 201);
    return o;
  };
  const decide = async (o, approve, answer) => {
    const dv = (await dispatcher.req('GET', `/api/orders/${o.id}/deadline-requests`)).body;
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${dv.open.id}/decide`, { approve, answer })).status, 200);
  };
  const waiting = await make('Ждём ответа', 6);
  const declined = await make('Отказали', 5);
  await decide(declined, false, 'Заказчик не согласен на перенос');
  const approved = await make('Согласились', 7);
  await decide(approved, true);
  const casesOf = async () => new Map((await h.req('GET', `/api/orgs/${o9.id}/cases`)).body.cases.map((c) => [c.id, c]));
  let cases = await casesOf();
  const w = cases.get(waiting.id);
  assert.deepEqual([w.org_extend?.state, w.org_extend?.new_deadline, w.extend?.by_org], ['waiting', addDays(today, 13), true]);
  const d = cases.get(declined.id);
  assert.deepEqual([d.org_extend?.state, d.org_extend?.answer, d.org_extend?.new_deadline, d.extend, d.deadline],
    ['declined', 'Заказчик не согласен на перенос', addDays(today, 12), null, addDays(today, 5)]);
  assert.ok(d.org_extend.decided_at);
  const a = cases.get(approved.id);
  assert.deepEqual([a.org_extend?.state, a.deadline], ['approved', addDays(today, 14)]);
  // Эксперт сам попросил перенос после отказа — у дела уже не «перенос от организации», а просьба эксперта.
  const own = await make('Эксперт попросил сам', 4);
  await decide(own, false);
  assert.equal((await e.req('POST', `/api/orders/${own.id}/deadline-requests`, { new_deadline: addDays(today, 9), reason: 'Ещё раз' })).status, 201);
  cases = await casesOf();
  assert.deepEqual([cases.get(own.id).org_extend, cases.get(own.id).extend?.by_org], [null, false]);
  // Чужой руководитель — не видит дел и не получает ответов.
  assert.equal((await other.req('GET', `/api/orgs/${o9.id}/cases`)).status, 404);

  // Сводка: отказ за сутки — один (второй отказ перекрыт просьбой эксперта); ведёт к отбору «Перенос от организации».
  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 1);
  const [r] = await S.sql`select ext_declined, stuck from org_morning_digests where user_id = ${h.user.id} and org_id = ${o9.id}`;
  assert.deepEqual({ ...r }, { ext_declined: 1, stuck: 0 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: диспетчер отказал в переносе срока по просьбе организации: 1');
  assert.equal(feed[0].section, `org=${o9.id}&to=orgext`);
  assert.doesNotMatch(JSON.stringify(feed), /Отказали|Заказчик не согласен|Заболел/);
  // Отказ старше суток — в сводку не идёт (в «Делах экспертов» по-прежнему виден).
  await S.sql`update deadline_requests set decided_at = now() - interval '25 hours' where order_id = ${declined.id}`;
  const { orgPart } = await import('../../src/ops/today-ops.mjs');
  assert.equal((await orgPart(S.sql, { id: o9.id, name: o9.name }, S.app.locals.registry, today)).ext_declined, 0);
  assert.equal((await casesOf()).get(declined.id).org_extend.state, 'declined');
});

// 2.249: эксперт сегодня вернулся после дней «не принимаю дела» — в утренней сводке руководителя «вернулись после дней «не
// принимаю дела»: N эксперт(ов)» (только те, у кого есть дела), ведёт к отбору «Эксперт вернулся после «не принимаю дела»»;
// в «Делах экспертов» у дел вернувшегося за неделю — когда вернулся и с какого дня не принимал.
test('2.249: вернулись после «не принимаю дела» — в утренней сводке руководителя и у дел в «Делах экспертов»', async () => {
  assert.equal(orgDigestText({ sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 1 }),
    'На сегодня по организации: вернулись после дней «не принимаю дела»: 1 эксперт');
  assert.equal(orgDigestText({ sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 3 }),
    'На сегодня по организации: вернулись после дней «не принимаю дела»: 3 эксперта');
  assert.equal(orgDigestTo({ sign: 1, handover: 1, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 2 }), 'back');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 1, ext_declined: 0, back: 2 }), 'away');

  const h = await login(S, '+79990003861');
  const other = await login(S, '+79990003862');
  const [today1, earlier, still, idle] = await Promise.all(['+79990003863', '+79990003864', '+79990003865', '+79990003866'].map((p) => login(S, p)));
  const o10 = await makeOrg(S.sql, 'ООО «Вернувшаяся оценка»');
  const oX = await makeOrg(S.sql, 'ООО «Посторонняя оценка»');
  await addMember(S.sql, o10.id, h.user.id, 'head');
  await addMember(S.sql, oX.id, other.user.id, 'head');
  for (const x of [today1, earlier, still, idle]) {
    await makeSpecialist(S.sql, x.user.id);
    await addMember(S.sql, o10.id, x.user.id, 'member');
    assert.equal((await x.req('PATCH', '/api/specialist/me', { org_id: o10.id })).status, 200);
  }
  const make = async (who, title, days) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
    assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    await S.sql`update orders set deadline = ${addDays(today, days)}::date where id = ${o.id}`;
    return o;
  };
  const a = await make(today1, 'Дело вернувшегося сегодня', 6);
  const b = await make(earlier, 'Дело вернувшегося раньше', 8);
  const c = await make(still, 'Дело того, кто ещё не вернулся', 20);
  // Вернулся сегодня (не принимал 10 дней), вернулся 3 дня назад, ещё не вернулся, вернулся сегодня, но дел нет.
  await S.sql`update specialists set away_since = ${addDays(today, -10)}::date, away_until = ${today}::date where user_id = ${today1.user.id}`;
  await S.sql`update specialists set away_since = ${addDays(today, -8)}::date, away_until = ${addDays(today, -3)}::date where user_id = ${earlier.user.id}`;
  await S.sql`update specialists set away_until = ${addDays(today, 4)}::date, away_note = 'отпуск' where user_id = ${still.user.id}`;
  await S.sql`update specialists set away_since = ${addDays(today, -5)}::date, away_until = ${today}::date where user_id = ${idle.user.id}`;

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:30') }) >= 1);
  const [r] = await S.sql`select back, away from org_morning_digests where user_id = ${h.user.id} and org_id = ${o10.id}`;
  assert.deepEqual({ ...r }, { back: 1, away: 0 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: вернулись после дней «не принимаю дела»: 1 эксперт');
  assert.equal(feed[0].section, `org=${o10.id}&to=back`);
  assert.doesNotMatch(JSON.stringify(feed), /Дело вернувшегося|отпуск/);
  // Посторонняя организация — ничего не знает о вернувшихся.
  const [rx] = await S.sql`select back from org_morning_digests where user_id = ${other.user.id} and org_id = ${oX.id}`;
  assert.equal(rx?.back ?? 0, 0);

  const cases = new Map((await h.req('GET', `/api/orgs/${o10.id}/cases`)).body.cases.map((x) => [x.id, x]));
  assert.deepEqual(cases.get(a.id).back, { since: addDays(today, -10), until: today, today: true });
  assert.deepEqual(cases.get(b.id).back, { since: addDays(today, -8), until: addDays(today, -3), today: false });
  assert.equal(cases.get(c.id).back, null);
  // Вернулся больше недели назад — пометка уходит.
  await S.sql`update specialists set away_until = ${addDays(today, -7)}::date where user_id = ${earlier.user.id}`;
  assert.equal((await h.req('GET', `/api/orgs/${o10.id}/cases`)).body.cases.find((x) => x.id === b.id).back, null);
  assert.equal((await other.req('GET', `/api/orgs/${o10.id}/cases`)).status, 404);
});

// 2.257: после «Вернуть эксперту» эксперт снова подписал файл, а в его новой ИИ-проверке расхождение с выпиской ЕГРН из
// пункта возврата осталось (как «расхождение осталось» в «Подписи организации», 2.247) — в утренней сводке руководителя
// «после возврата расхождение с выпиской ЕГРН осталось: N дело», ведёт к подписи организации; в «Сегодня» — красной строкой.
test('2.257: после возврата расхождение с выпиской осталось — в утренней сводке руководителя и в «Сегодня»', async () => {
  const z = { sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 0 };
  assert.equal(orgDigestText({ ...z, sign: 2, egrn_kept: 1 }),
    'На сегодня по организации: 2 дела ждут подписи организации, после возврата расхождение с выпиской ЕГРН осталось: 1 дело');
  assert.equal(orgDigestTo({ ...z, sign: 1, egrn_kept: 1, away: 1, back: 1, ext_declined: 1 }), 'sign');
  assert.equal(orgDigestTo({ ...z, sign: 1, egrn_kept: 1, stuck: 1, handover: 1 }), 'stuck');
  assert.equal(orgDigestTo({ ...z, sign: 1, egrn_kept: 0, away: 1 }), 'away');

  const h = await login(S, '+79990003871');
  const ex = await login(S, '+79990003872');
  const other = await login(S, '+79990003873');
  const o11 = await makeOrg(S.sql, 'ООО «Расхождение осталось»');
  const oX = await makeOrg(S.sql, 'ООО «Чужая подпись»');
  await addMember(S.sql, o11.id, h.user.id, 'head');
  await addMember(S.sql, oX.id, other.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, o11.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Эксперт Расхождений' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: o11.id })).status, 200);
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: расхождение после возврата' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const putTxt = (who, url, body, name) => who.req('POST', url, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  const sign = (d) => ex.req('POST', `/api/documents/${d.id}/sign`, { confirm: true });
  assert.equal((await putTxt(owner, `/api/orders/${o.id}/documents`, 'Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПлощадь, м2: 47,3\nНомер, тип этажа, на котором расположено помещение, машино-место: Этаж № 6\nАдрес (местоположение): г. Москва, тестовая ул., д. 15, кв. 18', 'Выписка ЕГРН.txt')).status, 201);
  const d1 = (await putTxt(ex, `/api/orders/${o.id}/results`, 'ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира, кадастровый номер 77:01:0001001:4321\nОбщей площадью 45,1 кв. м\nКвартира на 5 этаже', 'Отчёт.txt')).body.document;
  assert.equal((await sign(d1)).status, 201);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  const r = await h.req('POST', `/api/org-documents/${d1.id}/return`, { comment: '1. Площадь 45,1 кв. м не совпадает с площадью в выписке ЕГРН (47,3 кв. м) — исправьте по выписке\n2. Этаж 5 не совпадает с этажом в выписке ЕГРН (6) — исправьте по выписке' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Новая версия: площадь исправлена, этаж — нет; подписал, но ИИ-проверку после возврата ещё не запускал — не в счёт.
  const d2 = (await putTxt(ex, `/api/orders/${o.id}/results`, 'ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира, кадастровый номер 77:01:0001001:4321\nОбщей площадью 47,3 кв. м\nКвартира на 5 этаже', 'Отчёт 2.txt')).body.document;
  assert.equal((await sign(d2)).status, 201);
  const signRow = async () => (await h.req('GET', '/api/today')).body.orgs.find((g) => g.id === o11.id).to_sign.find((x) => x.order_ref.endsWith(o.id.slice(0, 8).toUpperCase()));
  assert.equal((await signRow()).egrn_kept, 0);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await signRow()).egrn_kept, 1);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:40') }) >= 1);
  const [d] = await S.sql`select sign, egrn_kept from org_morning_digests where user_id = ${h.user.id} and org_id = ${o11.id}`;
  assert.deepEqual({ ...d }, { sign: 1, egrn_kept: 1 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 1 дело ждёт подписи организации, после возврата расхождение с выпиской ЕГРН осталось: 1 дело');
  assert.equal(feed[0].section, `org=${o11.id}&to=sign`);
  assert.doesNotMatch(JSON.stringify(feed), /Квартира|Расхождений|47,3/);
  const [rx] = await S.sql`select egrn_kept from org_morning_digests where user_id = ${other.user.id} and org_id = ${oX.id}`;
  assert.equal(rx?.egrn_kept ?? 0, 0);

  // Третья версия с правильным этажом, подписана и проверена — расхождения нет.
  const d3 = (await putTxt(ex, `/api/orders/${o.id}/results`, 'ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира, кадастровый номер 77:01:0001001:4321\nОбщей площадью 47,3 кв. м\nКвартира на 6 этаже', 'Отчёт 3.txt')).body.document;
  assert.equal((await ex.req('DELETE', `/api/documents/${d2.id}`)).status, 204);
  assert.equal((await sign(d3)).status, 201);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await signRow()).egrn_kept, 0);
});

// 2.286: в ИИ-проверке эксперта у файла, который ждёт подписи организации, остались расхождения с заявкой или заданием на
// оценку (как отбор в «Подписи организации», 2.276) — в утренней сводке руководителя «на подписи — расхождения с заявкой или
// заданием на оценку: N дело», ведёт к подписи организации сразу с этим отбором; в «Сегодня» — сколько пунктов.
test('2.286: на подписи расхождения с заявкой или заданием на оценку — в утренней сводке руководителя и в «Сегодня»', async () => {
  const z = { sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 0, egrn_kept: 0 };
  assert.equal(orgDigestText({ ...z, sign: 3, order_diff: 2 }),
    'На сегодня по организации: 3 дела ждут подписи организации, на подписи — расхождения с заявкой или заданием на оценку: 2 дела');
  assert.equal(orgDigestTo({ ...z, sign: 1, order_diff: 1, away: 1, back: 1, ext_declined: 1 }), 'sign_order');
  assert.equal(orgDigestTo({ ...z, sign: 1, order_diff: 1, egrn_kept: 1 }), 'sign');
  assert.equal(orgDigestTo({ ...z, sign: 1, order_diff: 1, stuck: 1, handover: 1 }), 'stuck');
  assert.equal(orgDigestTo({ ...z, sign: 1, order_diff: 0, away: 1 }), 'away');

  const h = await login(S, '+79990003881');
  const ex = await login(S, '+79990003882');
  const other = await login(S, '+79990003883');
  const o12 = await makeOrg(S.sql, 'ООО «Сверка с заданием»');
  const oX = await makeOrg(S.sql, 'ООО «Чужая сверка»');
  await addMember(S.sql, o12.id, h.user.id, 'head');
  await addMember(S.sql, oX.id, other.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, o12.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Эксперт Сверки' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: o12.id })).status, 200);
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: расхождение с заданием' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const putTxt = (who, url, body, name) => who.req('POST', url, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  const sign = (d) => ex.req('POST', `/api/documents/${d.id}/sign`, { confirm: true });
  assert.equal((await putTxt(owner, `/api/orders/${o.id}/documents`, 'ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: 03.10.2026', 'Задание на оценку.txt')).status, 201);
  // Площадь — не как в заявке (40), дата оценки — не как в задании.
  const d1 = (await putTxt(ex, `/api/orders/${o.id}/results`, 'ОТЧЁТ ОБ ОЦЕНКЕ\nДата оценки: 01.10.2026\nКвартира общей площадью 45,1 кв. м', 'Отчёт.txt')).body.document;
  assert.equal((await sign(d1)).status, 201);
  const signRow = async () => (await h.req('GET', '/api/today')).body.orgs.find((g) => g.id === o12.id).to_sign.find((x) => x.order_ref.endsWith(o.id.slice(0, 8).toUpperCase()));
  assert.equal((await signRow()).order_diff, 0, 'ИИ-проверку не запускали — не в счёт');
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await signRow()).order_diff, 2);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:50') }) >= 1);
  const [d] = await S.sql`select sign, order_diff from org_morning_digests where user_id = ${h.user.id} and org_id = ${o12.id}`;
  assert.deepEqual({ ...d }, { sign: 1, order_diff: 1 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 1 дело ждёт подписи организации, на подписи — расхождения с заявкой или заданием на оценку: 1 дело');
  assert.equal(feed[0].section, `org=${o12.id}&to=sign_order`);
  assert.doesNotMatch(JSON.stringify(feed), /Квартира|Сверки|45,1|03\.10/);
  const [rx] = await S.sql`select order_diff from org_morning_digests where user_id = ${other.user.id} and org_id = ${oX.id}`;
  assert.equal(rx?.order_diff ?? 0, 0);

  // Исправленная версия подписана и проверена, прежняя удалена — расхождений нет.
  const d2 = (await putTxt(ex, `/api/orders/${o.id}/results`, 'ОТЧЁТ ОБ ОЦЕНКЕ\nДата оценки: 03.10.2026\nКвартира общей площадью 40 кв. м', 'Отчёт 2.txt')).body.document;
  assert.equal((await ex.req('DELETE', `/api/documents/${d1.id}`)).status, 204);
  assert.equal((await sign(d2)).status, 201);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await signRow()).order_diff, 0);
});

// 2.316: у дела на подписи организации срок по заданию на оценку сегодня или прошёл (2.308) — в утренней сводке руководителя
// «срок по заданию на оценку сегодня или прошёл — подпишите сегодня: N дело», ведёт к подписи организации раньше всего прочего.
// Срок завтра — не в счёт; чужая организация — ничего.
test('2.316: срок по заданию на оценку у дела на подписи — в утренней сводке руководителя', async () => {
  const z = { sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 0, egrn_kept: 0, order_diff: 0 };
  assert.equal(orgDigestText({ ...z, sign: 2, task_due: 1 }),
    'На сегодня по организации: 2 дела ждут подписи организации, срок по заданию на оценку сегодня или прошёл — подпишите сегодня: 1 дело');
  assert.equal(orgDigestTo({ ...z, sign: 1, task_due: 1, due: 1, overdue: 1, stuck: 1, order_diff: 1 }), 'sign');
  assert.equal(orgDigestTo({ ...z, sign: 1, task_due: 0, due: 1 }), 'week');

  const h = await login(S, '+79990003891');
  const ex = await login(S, '+79990003892');
  const other = await login(S, '+79990003893');
  const oT = await makeOrg(S.sql, 'ООО «Срок по заданию утром»');
  const oX = await makeOrg(S.sql, 'ООО «Чужой срок по заданию»');
  await addMember(S.sql, oT.id, h.user.id, 'head');
  await addMember(S.sql, oX.id, other.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, oT.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Эксперт Задания' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: oT.id })).status, 200);
  const putTxt = (who, url, body, name) => who.req('POST', url, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  const ruD = (s) => s.split('-').reverse().join('.');
  const signed = async (title, due) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 15), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
    assert.equal((await ex.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    assert.equal((await putTxt(owner, `/api/orders/${o.id}/documents`, `ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(due)}`, 'Задание на оценку.txt')).status, 201);
    const d = (await putTxt(ex, `/api/orders/${o.id}/results`, 'ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира', 'Отчёт.txt')).body.document;
    assert.equal((await ex.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
    return o;
  };
  await signed('Квартира: срок по заданию сегодня', today);
  await signed('Квартира: срок по заданию прошёл', addDays(today, -1));
  await signed('Квартира: срок по заданию завтра', tomorrow);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:55'), storage: S.providers.storage }) >= 1);
  const [d] = await S.sql`select sign, task_due from org_morning_digests where user_id = ${h.user.id} and org_id = ${oT.id}`;
  assert.deepEqual({ ...d }, { sign: 3, task_due: 2 });
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: 3 дела ждут подписи организации, срок по заданию на оценку сегодня или прошёл — подпишите сегодня: 2 дела');
  assert.equal(feed[0].section, `org=${oT.id}&to=sign`);
  assert.doesNotMatch(JSON.stringify(feed), /Квартира|Задания|Задание на оценку\.txt/);
  const [rx] = await S.sql`select task_due from org_morning_digests where user_id = ${other.user.id} and org_id = ${oX.id}`;
  assert.equal(rx?.task_due ?? 0, 0);
});

// 2.338: перенос срока согласован позже срока по заданию на оценку, а письма о переносе нет 2 дня и дольше после согласия
// диспетчера (как пометка в «Делах экспертов», 2.332) — в утренней сводке руководителя своей строкой, ведёт к отбору
// «Перенос позже срока по заданию — нет письма». Согласовано вчера — не в счёт; чужая организация — ничего.
test('2.338: перенос позже срока по заданию, а письма о переносе нет 2 дня — в утренней сводке руководителя', async () => {
  const z = { sign: 0, handover: 0, stuck: 0, due: 0, overdue: 0, idle: 0, returned: 0, fresh: 0, away: 0, ext_declined: 0, back: 0, egrn_kept: 0, order_diff: 0, task_due: 0 };
  assert.equal(orgDigestText({ ...z, task_moved: 2 }),
    'На сегодня по организации: перенос срока согласован позже срока по заданию на оценку, а письма о переносе нет 2 дня и дольше: 2 дела');
  assert.equal(orgDigestTo({ ...z, sign: 1, task_moved: 1, ext_declined: 1, away: 1 }), 'task_moved');
  assert.equal(orgDigestTo({ ...z, task_moved: 1, order_diff: 1 }), 'sign_order');
  assert.equal(orgDigestTo({ ...z, task_moved: 1, due: 1 }), 'week');

  const h = await login(S, '+79990003894');
  const ex = await login(S, '+79990003895');
  const other = await login(S, '+79990003896');
  const oT = await makeOrg(S.sql, 'ООО «Перенос без письма утром»');
  const oX = await makeOrg(S.sql, 'ООО «Чужой перенос без письма»');
  await addMember(S.sql, oT.id, h.user.id, 'head');
  await addMember(S.sql, oX.id, other.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, oT.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Эксперт Переносов' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: oT.id })).status, 200);
  const putTxt = (who, url, body, name) => who.req('POST', url, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  const ruD = (s) => s.split('-').reverse().join('.');
  const moved = async (title, agoDays) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 5), fields: { ...FIELDS, purpose: 'bank' } })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
    assert.equal((await ex.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    assert.equal((await putTxt(owner, `/api/orders/${o.id}/documents`, `ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(addDays(today, 5))}`, 'Задание банка Переносова.txt')).status, 201);
    const r = await ex.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: addDays(today, 14), reason: 'Банк согласовал устно' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${r.body.open.id}/decide`, { approve: true })).status, 200);
    await S.sql`update deadline_requests set decided_at = now() - make_interval(days => ${agoDays}) where order_id = ${o.id}`;
    return o;
  };
  await moved('Квартира: перенос без письма три дня', 3);
  await moved('Квартира: перенос без письма вчера', 1);

  assert.ok(await sendOrgMorning(S.sql, S.app.locals.registry, { now: at(today, '08:56'), storage: S.providers.storage }) >= 1);
  const [d] = await S.sql`select task_moved from org_morning_digests where user_id = ${h.user.id} and org_id = ${oT.id}`;
  assert.equal(d.task_moved, 1);
  const feed = (await h.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня по организации'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня по организации: перенос срока согласован позже срока по заданию на оценку, а письма о переносе нет 2 дня и дольше: 1 дело');
  assert.equal(feed[0].section, `org=${oT.id}&to=task_moved`);
  assert.doesNotMatch(JSON.stringify(feed), /Квартира|Переносов/);
  const [rx] = await S.sql`select task_moved from org_morning_digests where user_id = ${other.user.id} and org_id = ${oX.id}`;
  assert.equal(rx?.task_moved ?? 0, 0);
});

// Прогон 2.340: одно дело организации для банка по всей пачке 2.331–2.339 — перенос согласован позже срока по заданию,
// эксперт просит письмо, приходит письмо с коротким сроком, затем с согласованным; дело сдано. Исправлено: письмо с коротким
// сроком в утренней сводке руководителя не считалось «письма нет» (а в «Делах экспертов» и в сводке за месяц — считалось);
// прежний срок из первого письма в блоке задания и в «Сроке» назывался «по заданию было».
test('прогон 2.340: перенос позже срока по заданию — эксперт и руководитель от согласия до сданного дела', async () => {
  const { expertMorningAlerts, orgPart } = await import('../../src/ops/today-ops.mjs');
  const h = await login(S, '+79990003897');
  const ex = await login(S, '+79990003898');
  const oP = await makeOrg(S.sql, 'ООО «Прогон 2.340»');
  await addMember(S.sql, oP.id, h.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, oP.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Эксперт Прогонов' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: oP.id })).status, 200);
  const ruD = (s) => s.split('-').reverse().join('.');
  const due = addDays(today, 5), short = addDays(today, 8), late = addDays(today, 12);
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: прогон 2.340' })).body.order;
  const put = (body, name, kind = 'basis') => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': kind } });
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: due, fields: { ...FIELDS, purpose: 'bank' } })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(due)}`, 'Задание банка.txt')).status, 201);
  const r = await ex.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: late, reason: 'Банк согласовал устно' });
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${r.body.open.id}/decide`, { approve: true })).status, 200);
  await S.sql`update deadline_requests set decided_at = now() - interval '3 days' where order_id = ${o.id}`;
  const opts = { registry: S.app.locals.registry, storage: S.providers.storage };
  const [org] = await S.sql`select * from organizations where id = ${oP.id}`;
  const look = async () => {
    const t = (await ex.req('GET', '/api/today')).body.expert;
    const cs = (await h.req('GET', `/api/orgs/${oP.id}/cases`)).body.cases;
    return {
      today: t.task_moved.find((x) => x.id === o.id)?.task_moved ?? null,
      today_due: t.task_due.some((x) => x.id === o.id),
      morning: (await expertMorningAlerts(S.sql, ex.user.id, today, new Date(), opts)).task_moved,
      org: cs.find((x) => x.id === o.id)?.task_moved ?? null,
      org_long: (await orgPart(S.sql, org, S.app.locals.registry, today, { storage: S.providers.storage })).task_moved_long,
      deadline: (await ex.req('GET', `/api/orders/${o.id}/deadline-requests`)).body,
      task: (await ex.req('GET', `/api/orders/${o.id}/task`)).body.items.find((x) => x.id === 'moved') ?? null,
    };
  };
  // 1. Согласовано 3 дня назад, письма не просили: «Сегодня» и утренняя сводка эксперта (2.326, 2.331), у руководителя —
  // пометка и утренняя сводка (2.332, 2.338); строки «срок по заданию близко» нет.
  let v = await look();
  assert.equal(v.today?.day, due);
  assert.equal(v.today_due, false);
  assert.equal(v.morning, 1);
  assert.deepEqual([v.org?.day, v.org?.deadline, v.org?.asked, v.org?.letter], [due, late, null, null]);
  assert.equal(v.org_long, 1);
  // 2. Попросил письмо: у эксперта ждём — ни строки, ни сводки; руководитель видит «попросил», письма всё ещё нет.
  const q = await ex.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
  const req = q.body.requests.find((x) => x.item_id === 'task_move');
  v = await look();
  assert.equal(v.today, null);
  assert.equal(v.morning, 0);
  assert.ok(v.org.asked);
  assert.equal(v.org_long, 1);
  // 3. Письмо с коротким сроком (2.335): у эксперта снова строка и сводка, срок по заданию — из письма; у руководителя —
  // «письмо пришло, но срок в нём …» и в утренней сводке тоже (исправлено в прогоне).
  const d1 = await put(`Банк сообщает: срок составления отчёта продлён, не позднее ${ruD(short)}`, 'Письмо о переносе.txt', 'other');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req.id}/attach`, { document_id: d1.body.document.id })).status, 200);
  v = await look();
  assert.deepEqual([v.today?.day, v.today?.letter], [short, { was: due }]);
  assert.equal(v.morning, 1);
  assert.deepEqual(v.org.letter, { was: due });
  assert.equal(v.org_long, 1);
  assert.deepEqual([v.task.v, v.task.was, v.task.was_letter], [`на ${ruD(short)}`, ruD(due), false]);
  // 4. Второе письмо с согласованным сроком: пометок нет нигде; в блоке задания прежний срок — «по прежнему письму»;
  // «История сроков» (2.337) — оба письма по порядку.
  const q2 = await ex.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
  const req2 = q2.body.requests.find((x) => x.item_id === 'task_move' && x.id !== req.id);
  const d2 = await put(`Банк сообщает: срок составления отчёта продлён, не позднее ${ruD(late)}`, 'Письмо о переносе 2.txt', 'other');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req2.id}/attach`, { document_id: d2.body.document.id })).status, 200);
  v = await look();
  assert.deepEqual([v.today, v.morning, v.org, v.org_long, v.deadline.task_moved], [null, 0, null, 0, null]);
  assert.deepEqual([v.task.v, v.task.was, v.task.was_letter], [`на ${ruD(late)}`, ruD(short), true]);
  assert.deepEqual(v.deadline.history.map((x) => x.kind), ['start', 'task', 'request', 'ask', 'letter', 'ask', 'letter']);
  assert.deepEqual(v.deadline.history.filter((x) => x.kind === 'letter').map((x) => [x.was, x.day]), [[due, short], [short, late]]);
  // «Мои сроки» (2.339): срок по письму — день срока дела, у срока дела «срок по письму о переносе — тот же день».
  const sc = (await ex.req('GET', '/api/specialist/me/schedule')).body.schedule;
  const dl = sc.days.flatMap((x) => x.items).find((x) => x.order_id === o.id && x.kind === 'deadline');
  assert.equal(dl?.task_letter?.day, late);
  // 5. Сдано: в сводке за месяц — перенос по просьбе эксперта позже срока по заданию, письмо о переносе есть (2.336).
  await S.sql`update orders set status = 'done' where id = ${o.id}`;
  await S.sql`insert into order_status_history (order_id, from_status, to_status, side) values (${o.id}, 'review', 'done', 'dispatcher')`;
  const rep = (await h.req('GET', `/api/orgs/${oP.id}/report`)).body.report;
  const row = rep.experts.find((x) => x.user_id === ex.user.id);
  assert.deepEqual([row.ext_cases, row.ext_times, row.ext_need, row.ext_letter], [1, 1, 1, 1]);
});

// Прогон 2.350: одно дело организации для банка по всей пачке 2.341–2.349 — перенос согласован позже срока по заданию, пришло
// письмо банка о переносе со сроком завтра (раньше согласованного): «Сегодня», утренняя сводка и «История сроков» эксперта,
// «Дела экспертов» и карточка эксперта у руководителя; эксперт просит письмо с новым сроком, напоминает заказчику, загружает
// файл; приходит письмо с согласованным сроком — пометок нет; сдано — сводка за месяц. Исправлено: в утренней сводке эксперта
// такое дело называлось «приложите письмо о переносе» (письмо уже пришло), а попросил письмо с новым сроком — в сводке не было
// ничего, хотя банк ждёт отчёт завтра; в карточке эксперта не было «сдать по письму к …» и дело считалось «без письма».
test('прогон 2.350: письмо о переносе со сроком завтра — эксперт и руководитель от письма до сданного дела', async () => {
  const { expertMorningAlerts, orgPart } = await import('../../src/ops/today-ops.mjs');
  const h = await login(S, '+79990003911');
  const ex = await login(S, '+79990003912');
  const oP = await makeOrg(S.sql, 'ООО «Прогон 2.350»');
  await addMember(S.sql, oP.id, h.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, oP.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Эксперт Письмов' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: oP.id })).status, 200);
  const ruD = (s) => s.split('-').reverse().join('.');
  const due = addDays(today, -1), short = addDays(today, 1), late = addDays(today, 12);
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: прогон 2.350' })).body.order;
  const put = (body, name, kind = 'basis') => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': kind } });
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 3), fields: { ...FIELDS, purpose: 'bank' } })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(due)}`, 'Задание банка.txt')).status, 201);
  const r = await ex.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: late, reason: 'Банк согласовал устно' });
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${r.body.open.id}/decide`, { approve: true })).status, 200);
  await S.sql`update deadline_requests set decided_at = now() - interval '3 days' where order_id = ${o.id}`;
  const q = await ex.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
  const req = q.body.requests.find((x) => x.item_id === 'task_move');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req.id}/attach`, {
    document_id: (await put(`Банк сообщает: срок составления отчёта продлён, не позднее ${ruD(short)}`, 'Письмо о переносе.txt', 'other')).body.document.id })).status, 200);
  const opts = { registry: S.app.locals.registry, storage: S.providers.storage };
  const [org] = await S.sql`select * from organizations where id = ${oP.id}`;
  const look = async () => {
    const t = (await ex.req('GET', '/api/today')).body.expert;
    const dl = (await ex.req('GET', `/api/orders/${o.id}/deadline-requests`)).body;
    return {
      letter_due: t.letter_due.find((x) => x.id === o.id) ?? null,
      letter_sign: t.letter_sign.find((x) => x.id === o.id) ?? null,
      moved: t.task_moved.some((x) => x.id === o.id),
      morning: await expertMorningAlerts(S.sql, ex.user.id, today, new Date(), opts),
      org: (await h.req('GET', `/api/orgs/${oP.id}/cases`)).body.cases.find((x) => x.id === o.id)?.task_moved ?? null,
      org_long: (await orgPart(S.sql, org, S.app.locals.registry, today, { storage: S.providers.storage })).task_moved_long,
      card: (await h.req('GET', `/api/specialists/${ex.user.id}/card`)).body.now.cases[0].task_moved,
      short: dl.history?.findLast((x) => x.kind === 'letter')?.short ?? null,
      remind: dl.task_moved?.asked?.remind ?? null,
    };
  };
  // 1. Письмо со сроком завтра: «Сдать по письму» (2.341), в «Приложите письмо» не повторяется; утренняя сводка — своей
  // строкой «срок по письму», не «приложите письмо» (исправлено); руководитель — «сдать по письму к …, завтра» в «Делах
  // экспертов» и в карточке эксперта (2.348, 2.342 — исправлено); «История сроков» — пометка и «Попросить» (2.349).
  let v = await look();
  assert.deepEqual([v.letter_due?.letter_due.day, v.letter_due?.can_ask, v.moved], [short, true, false]);
  assert.deepEqual([v.morning.letter_due, v.morning.task_moved, v.morning.task_due], [1, 0, 0]);
  assert.match(digestText({ ...v.morning, due: 0, overdue: 0, visits: 0, links: 0 }),
    /срок по письму о переносе сегодня, завтра или прошёл, а файла результата нет: 1 дело/);
  assert.deepEqual([v.org?.day, v.org?.letter, v.org?.letter_due, v.org?.asked], [short, { was: due }, { days_left: 1, overdue: false, hot: true }, null]);
  assert.deepEqual(v.card, v.org, 'карточка эксперта — как «Дела экспертов»');
  assert.equal(v.org_long, 1);
  assert.deepEqual(v.short, { deadline: late, can_ask: true });
  // 2. Попросил письмо с новым сроком: строка «Сдать по письму» остаётся без кнопки, в сводке — тоже (банк ждёт отчёт
  // завтра, исправлено); у руководителя — «эксперт попросил»; в «Истории сроков» кнопки нет.
  const q2 = await ex.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
  const req2 = q2.body.requests.find((x) => x.item_id === 'task_move' && x.id !== req.id);
  v = await look();
  assert.equal(v.letter_due?.can_ask, false);
  assert.deepEqual([v.morning.letter_due, v.morning.task_moved], [1, 0]);
  assert.ok(v.org.asked && v.card.asked);
  assert.deepEqual(v.short, { deadline: late, can_ask: false });
  assert.equal(v.remind, null);
  // 3. Письмо не пришло 4 дня — «Напомнить заказчику» (2.347) у строки «Сдать по письму».
  await S.sql`update doc_requests set requested_at = now() - interval '4 days' where id = ${req2.id}`;
  v = await look();
  assert.equal(v.remind?.can_remind, true);
  assert.equal(v.letter_due?.task_moved.asked.remind.can_remind, true);
  // 2.355: в утренней сводке — цифрой «напомните заказчику», сводка ведёт к «Сегодня».
  assert.deepEqual([v.morning.letter_due, v.morning.letter_wait], [1, 1]);
  assert.match(digestText({ ...v.morning, due: 0, overdue: 0, visits: 0, links: 0 }),
    /письмо о переносе попросили, а оно не пришло 3 дня и дольше — напомните заказчику: 1 дело/);
  assert.equal(morningTo({ ...v.morning, due: 0, overdue: 0, visits: 0, links: 0 }), 'today');
  // 4. Файл результата загружен — «Сдать по письму» уходит и в «Сегодня», и в сводке; файл не подписан — «Подпишите до …»
  // (2.351), там же напоминание: письмо ждём; в «Приложите письмо» не повторяется.
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/results`, Buffer.from('файл Отчёт.pdf'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт.pdf') } })).status, 201);
  v = await look();
  assert.equal(v.letter_due, null);
  assert.deepEqual([v.letter_sign?.letter_due.day, v.letter_sign?.file.filename, v.letter_sign?.can_ask], [short, 'Отчёт.pdf', false]);
  assert.equal(v.letter_sign.task_moved.asked.remind.can_remind, true, 'письмо с новым сроком не пришло 4 дня — «Напомнить заказчику»');
  assert.equal(v.moved, false);
  assert.deepEqual([v.morning.letter_due, v.morning.task_moved, v.morning.letter_wait], [0, 0, 1]);
  // 2.355: напомнил — до завтра цифры нет.
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/doc-requests/remind`)).status, 201);
  assert.equal((await look()).morning.letter_wait, 0);
  await S.sql`update doc_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await look()).morning.letter_wait, 1);
  // 5. Пришло письмо с согласованным сроком — пометок нет нигде.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req2.id}/attach`, {
    document_id: (await put(`Банк сообщает: срок составления отчёта продлён, не позднее ${ruD(late)}`, 'Письмо о переносе 2.txt', 'other')).body.document.id })).status, 200);
  v = await look();
  assert.deepEqual([v.letter_due, v.letter_sign, v.moved, v.morning.letter_due, v.morning.task_moved, v.morning.letter_wait, v.org, v.card, v.org_long, v.short, v.remind],
    [null, null, false, 0, 0, 0, null, null, 0, null, null]);
  // 6. Сдано: в сводке за месяц — срок по письму о переносе (2.346), сдано не позже срока из последнего письма.
  await S.sql`update orders set status = 'done' where id = ${o.id}`;
  await S.sql`insert into order_status_history (order_id, from_status, to_status, side) values (${o.id}, 'review', 'done', 'dispatcher')`;
  const rep = (await h.req('GET', `/api/orgs/${oP.id}/report`)).body.report;
  const row = rep.experts.find((x) => x.user_id === ex.user.id);
  assert.deepEqual([row.letter_cases, row.letter_late, row.task_cases ?? 0], [1, 0, 0]);
});
