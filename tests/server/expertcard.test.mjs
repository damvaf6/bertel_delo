// Карточка эксперта (2.35): квалификация, допуски, досье без копий, итоги работы (сдано в срок, возвраты), загрузка,
// история дел без данных заказчика; видят диспетчер и руководитель организации эксперта. Итоги идут в «качество» подбора.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { scoreSpecialist } from '../../src/matching/score.mjs';

let S, owner, dispatcher, spec, head, headOther, org;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Карточная, 3', area: '40' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003601');
  dispatcher = await login(S, '+79990003602');
  spec = await login(S, '+79990003603');
  head = await login(S, '+79990003604');
  headOther = await login(S, '+79990003605');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  org = await makeOrg(S.sql, 'ООО «Карточка»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, spec.user.id, 'member');
  const other = await makeOrg(S.sql, 'ООО «Другая»');
  await addMember(S.sql, other.id, headOther.user.id, 'head');
  await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Карточкин' });
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
});
after(async () => { await S?.close(); });

async function step(c, o, to, reason) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...(reason ? { reason } : {}) });
}

test('качество в подборе: доля принятых, в срок и без возвратов — среднее; мало данных — нейтрально', () => {
  const spec0 = { regions: ['moscow'], capacity: 5, external_load: 0 };
  const q = (stats) => scoreSpecialist(spec0, { open: 0, offers: 0, accepted: 0, ...stats }, { fields: {} }, null).features.quality;
  assert.equal(q({}).score, 70);
  assert.equal(q({ done: 2, on_time: 0, returned: 2 }).score, 70, 'двух дел мало');
  assert.equal(q({ done: 4, on_time: 2, returned: 1 }).score, 63, '(50 + 75) / 2');
  assert.match(q({ done: 4, on_time: 2, returned: 1 }).note, /в срок 2 из 4; возвратов на доработку: 1/);
  assert.equal(q({ offers: 4, accepted: 4, done: 4, on_time: 4, returned: 0 }).score, 100);
});

test('карточка эксперта: досье без копий, допуски, итоги, история; руководитель своей организации — да, чужой — нет', async () => {
  // Досье: аттестат с копией.
  const item = (await spec.req('POST', '/api/specialist/me/dossier', { kind: 'certificate', title: 'Оценка недвижимости', number: '012345-1', valid_until: addDays(todayMsk(), 200) })).body;
  assert.ok(item.item?.id || item.items, JSON.stringify(item));
  // Два сданных дела: одно в срок, одно — с возвратом от диспетчера.
  for (const [title, back] of [['Дело в срок', false], ['Дело с возвратом', true]]) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 5), fields: FIELDS });
    await step(owner, o, 'matching');
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
    assert.equal((await step(spec, o, 'in_work')).status, 200);
    await S.sql`update orders set status = 'review' where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, actor_id) values (${o.id}, 'in_work', 'review', 'executor', ${spec.user.id})`;
    if (back) {
      assert.equal((await step(dispatcher, o, 'in_work', 'Нет фото')).status, 200);
      await S.sql`update orders set status = 'review' where id = ${o.id}`;
    }
    await S.sql`update orders set status = 'done' where id = ${o.id}`;
  }
  for (const c of [dispatcher, head, spec]) {
    const r = await c.req('GET', `/api/specialists/${spec.user.id}/card`);
    assert.equal(r.status, 200);
    const card = r.body;
    assert.equal(card.specialist.full_name, 'Эксперт Карточкин');
    assert.equal(card.specialist.org.name, 'ООО «Карточка»');
    assert.deepEqual(card.dossier.map((d) => [d.kind, d.number, d.has_copy, d.state]), [['certificate', '012345-1', false, 'ok']]);
    assert.ok(!('file' in card.dossier[0]), 'копии и ссылки на них в карточке нет');
    assert.deepEqual([card.stats.done, card.stats.on_time, card.stats.returned, card.stats.accepted], [2, 2, 1, 2]);
    assert.equal(card.history.length, 2);
    assert.deepEqual(card.history.map((h) => h.returns).sort(), [0, 1]);
    const text = JSON.stringify(card);
    for (const secret of ['Дело в срок', 'Карточная', owner.user.id]) assert.ok(!text.includes(secret), `в карточке нет: ${secret}`);
  }
  assert.equal((await headOther.req('GET', `/api/specialists/${spec.user.id}/card`)).status, 404);
  assert.equal((await owner.req('GET', `/api/specialists/${spec.user.id}/card`)).status, 404);
  // Ушёл из организации — бывший руководитель карточку не видит.
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${spec.user.id}`;
  assert.equal((await head.req('GET', `/api/specialists/${spec.user.id}/card`)).status, 404);
});
