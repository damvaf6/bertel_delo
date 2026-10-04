// «Сегодня» (2.34): эксперту — что горит по срокам, что вернули на доработку, что на проверке, новые предложения;
// руководителю экспертной организации — то же по делам его экспертов (без данных заказчика), подписи организации,
// возвраты и дела, предложенные организации. Чужие дела и чужие организации не видны.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, spec, head, other, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 77', area: '41' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003401');
  dispatcher = await login(S, '+79990003402');
  spec = await login(S, '+79990003403');
  head = await login(S, '+79990003404');
  other = await login(S, '+79990003405');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  await makeSpecialist(S.sql, other.user.id);
  org = await makeOrg(S.sql, 'ООО «Сегодняшняя оценка»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, spec.user.id, 'member');
  await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Сегодняшний' });
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
});
after(async () => { await S?.close(); });

async function step(c, o, to, reason) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...(reason ? { reason } : {}) });
}
const result = (o, name, who = spec) => who.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`файл ${name}`), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});

async function offered(title, days, who = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), days), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  return o;
}
const ids = (list) => list.map((x) => x.id);

test('«Сегодня» у эксперта: горит, вернули, на проверке, предложено; у руководителя — дела экспертов без данных заказчика', async () => {
  const fire = await offered('Горящее дело', 1);
  assert.equal((await step(spec, fire, 'in_work')).status, 200);
  const calm = await offered('Спокойное дело', 20);
  assert.equal((await step(spec, calm, 'in_work')).status, 200);
  const offer = await offered('Новое предложение', 9);
  const sent = await offered('Сдано на проверку', 5);
  assert.equal((await step(spec, sent, 'in_work')).status, 200);
  // Диспетчер вернул на доработку с причиной.
  const back = await offered('Вернули на доработку', 6);
  assert.equal((await step(spec, back, 'in_work')).status, 200);
  await S.sql`update orders set status = 'review' where id in (${sent.id}, ${back.id})`;
  assert.equal((await step(dispatcher, back, 'in_work', 'В разделе 3 нет даты осмотра')).status, 200);

  let t = (await spec.req('GET', '/api/today')).body;
  assert.deepEqual(ids(t.expert.hot), [fire.id], 'горит только дело со сроком через день');
  assert.deepEqual(ids(t.expert.offers), [offer.id]);
  assert.ok(t.expert.offers[0].fee_kop > 0);
  assert.deepEqual(ids(t.expert.review), [sent.id]);
  assert.deepEqual(t.expert.returned.map((x) => [x.id, x.by, x.comment]), [[back.id, 'Диспетчер', 'В разделе 3 нет даты осмотра']]);
  assert.deepEqual(t.orgs, [], 'эксперт — не руководитель');

  // Руководитель: подпись организации ждёт, после возврата — «вернул, ждём исправления».
  await head.req('PATCH', '/api/me', { full_name: 'Руководитель Сегодняшний' });
  const d = (await result(fire, 'Отчёт.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  t = (await head.req('GET', '/api/today')).body;
  assert.equal(t.expert, null, 'руководитель — не специалист');
  assert.equal(t.orgs.length, 1);
  const g = t.orgs[0];
  assert.equal(g.name, org.name);
  assert.deepEqual(g.hot.map((x) => [x.expert, x.service, x.overdue]), [['Эксперт Сегодняшний', 'Оценка недвижимости', false]]);
  assert.equal(g.to_sign.length, 1);
  assert.equal(g.to_sign[0].files, 1);
  const text = JSON.stringify(t);
  for (const secret of ['Горящее дело', 'тестовая ул.', fire.id]) assert.ok(!text.includes(secret), `руководитель не видит: ${secret}`);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: 'Проверьте итог' })).status, 201);
  t = (await head.req('GET', '/api/today')).body;
  assert.equal(t.orgs[0].to_sign.length, 0);
  assert.deepEqual(t.orgs[0].returned.map((x) => x.comment), ['Проверьте итог']);
  // Эксперт видит возврат руководителя.
  const mine = (await spec.req('GET', '/api/today')).body.expert.returned;
  assert.ok(mine.some((x) => x.id === fire.id && x.by === 'Руководитель (Руководитель Сегодняшний)' && x.comment === 'Проверьте итог'));

  // Дело, предложенное организации, — у руководителя «ждут назначения».
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело организации' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 8), fields: FIELDS });
  await step(owner, o, 'matching');
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: org.id, from: 'matching' })).status, 200);
  assert.equal((await head.req('GET', '/api/today')).body.orgs[0].pending.length, 1);
  void calm;
});

test('«Сегодня»: чужие дела и чужие организации не видны; заказчику — пусто', async () => {
  const o = await offered('Дело другого эксперта', 1, other);
  assert.equal((await step(other, o, 'in_work')).status, 200);
  const t = (await spec.req('GET', '/api/today')).body;
  assert.ok(!JSON.stringify(t).includes(o.id), 'дело другого эксперта не видно');
  const mine = (await other.req('GET', '/api/today')).body;
  assert.deepEqual(ids(mine.expert.hot), [o.id]);
  assert.deepEqual(mine.orgs, []);
  const c = (await owner.req('GET', '/api/today')).body;
  assert.deepEqual([c.expert, c.orgs, c.dispatcher], [null, [], null]);
  assert.equal((await spec.req('GET', '/api/today')).body.dispatcher, null, 'раздел диспетчера — только диспетчеру');
  // Сотрудник организации (не руководитель) не получает раздела организации.
  assert.deepEqual((await spec.req('GET', '/api/today')).body.orgs, []);
});

test('«Сегодня» у диспетчера (2.42): назначить цену, подобрать после отказа, молчащий исполнитель, проверка, горит срок, деньги', async () => {
  const draft = async (title, days) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), days), fields: FIELDS })).status, 200);
    assert.equal((await step(owner, o, 'matching')).status, 200);
    return o;
  };
  const noPrice = await draft('Без цены', 10);
  const declined = await offered('Отказ эксперта', 8);
  assert.equal((await step(spec, declined, 'matching', 'Нет времени')).status, 200);
  const silent = await offered('Молчит', 7);
  await S.sql`update order_offers set offered_at = now() - interval '25 hours' where order_id = ${silent.id}`;
  const hot = await offered('Горит у диспетчера', 1);
  assert.equal((await step(spec, hot, 'in_work')).status, 200);
  const rev = await offered('На проверке', 5);
  assert.equal((await step(spec, rev, 'in_work')).status, 200);
  await S.sql`update orders set status = 'review' where id = ${rev.id}`;
  await S.sql`insert into payouts (order_id, executor_user_id, amount_kop, commission_kop, status, failure) values (${rev.id}, ${spec.user.id}, 100, 0, 'failed', 'тест: отклонено')`;

  const d = (await dispatcher.req('GET', '/api/today')).body.dispatcher;
  assert.ok(ids(d.price).includes(noPrice.id));
  const m = d.to_match.find((x) => x.id === declined.id);
  assert.equal(m.reason, 'Нет времени');
  assert.ok(ids(d.slow_offers).includes(silent.id));
  assert.ok(!ids(d.slow_offers).includes(hot.id), 'принятое дело не «молчит»');
  assert.ok(ids(d.hot).includes(hot.id));
  assert.ok(ids(d.review).includes(rev.id));
  const money = d.money.find((x) => x.id === rev.id);
  assert.deepEqual([money.what, money.failure], ['payout', 'тест: отклонено']);
  await S.sql`delete from payouts where order_id = ${rev.id}`;
});
