// Утренняя сводка руководителю «На сегодня по организации» (2.121): раз в день после 8:00 по Москве — одно уведомление на
// организацию: сколько дел ждут подписи организации, просьб экспертов передать дело, дел экспертов со сроком сегодня и с
// прошедшим сроком. Нечего сообщить — не приходит. В ленте и СМС — только цифры (организация — строкой ниже в ленте);
// ведёт в организацию. Чужая организация и не руководитель — ничего.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { orgDigestText, orgDigestTo, sendOrgMorning } from '../../src/notify/morning.mjs';

let S, owner, dispatcher, spec, head, head2, idleHead, org, idleOrg;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Руководящая ул., 21', area: '40' };
const today = todayMsk();
const tomorrow = addDays(today, 1);
const at = (day, time) => new Date(`${day}T${time}:00+03:00`);

before(async () => {
  S = await startApp();
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
  assert.equal(feed[0].title, 'На сегодня по организации: 1 дело ждёт подписи организации, 1 просьба передать дело, у экспертов сдать сегодня 1 дело, 1 дело с прошедшим сроком');
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
  assert.equal(orgDigestTo({ sign: 2, handover: 1, due: 0, overdue: 1 }), 'week');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 1, overdue: 0 }), 'week');
  assert.equal(orgDigestTo({ sign: 1, handover: 1, due: 0, overdue: 0 }), 'sign');
  assert.equal(orgDigestTo({ sign: 0, handover: 2, due: 0, overdue: 0 }), 'handover');
  assert.equal(orgDigestTo({ sign: 0, handover: 0, due: 0, overdue: 0 }), null);
});
