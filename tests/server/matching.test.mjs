// Подбор исполнителя (задача 1.4): допуск обязателен, оценка по признакам, предложение, отказ, переназначение.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { scoreSpecialist, WEIGHTS } from '../../src/matching/score.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, a, b, c, off;
const today = todayMsk();

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000401');
  dispatcher = await login(S, '+79990000402');
  a = await login(S, '+79990000411'); // Москва и область, свободен
  b = await login(S, '+79990000412'); // только Москва
  c = await login(S, '+79990000413'); // допуск на землю, не на недвижимость
  off = await login(S, '+79990000414'); // отключил приём дел
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, a.user.id);
  await makeSpecialist(S.sql, b.user.id, { regions: ['moscow'] });
  await makeSpecialist(S.sql, c.user.id, { permits: [['expertise', 'land']] });
  await makeSpecialist(S.sql, off.user.id);
  await S.sql`update specialists set active = false where user_id = ${off.user.id}`;
});
after(async () => { await S?.close(); });

async function submitted(region = 'mo', deadline = addDays(today, 20), by = owner) {
  const o = (await by.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  const r = await by.req('PATCH', `/api/orders/${o.id}`, { deadline, fields: { purpose: 'deal', region, object_type: 'flat', address: 'тестовый адрес, 1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await by.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  return o;
}
const cands = async (o) => (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
const offer = async (o, who, from = 'matching') => {
  await ensurePaid(S.sql, o.id);
  return dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from });
};

test('оценка по признакам: веса дают сумму, район и загрузка меняют итог', () => {
  assert.equal(Object.values(WEIGHTS).reduce((x, y) => x + y, 0), 100);
  const spec = { regions: ['moscow'], capacity: 4, external_load: 0 };
  const idle = scoreSpecialist(spec, { open: 0, offers: 0, accepted: 0 }, { fields: { region: 'moscow' } }, 20);
  assert.equal(idle.features.region.score, 100);
  assert.equal(idle.features.load.score, 100);
  assert.equal(idle.features.quality.score, 70, 'мало данных — нейтрально');
  const far = scoreSpecialist(spec, { open: 0, offers: 0, accepted: 0 }, { fields: { region: 'mo' } }, 20);
  assert.ok(far.total < idle.total);
  const busy = scoreSpecialist(spec, { open: 3, offers: 4, accepted: 1 }, { fields: { region: 'moscow' } }, 1);
  assert.equal(busy.features.load.score, 25);
  assert.equal(busy.features.deadline.score, 25, 'срочное дело — важна свободная загрузка');
  assert.equal(busy.features.quality.score, 25);
  assert.ok(busy.total < idle.total);
  const external = scoreSpecialist({ ...spec, external_load: 4 }, { open: 0, offers: 0, accepted: 0 }, { fields: {} }, null);
  assert.equal(external.features.load.score, 0, 'дела вне платформы тоже считаются');
});

test('в подбор попадают только допущенные и принимающие дела; район и загрузка влияют на порядок', async () => {
  const o = await submitted('mo');
  const list = await cands(o);
  assert.deepEqual(list.map((x) => x.user_id).sort(), [a.user.id, b.user.id].sort(), 'без допуска и с выключенным приёмом — не в списке');
  assert.equal(list[0].user_id, a.user.id, 'работает в области — выше');
  assert.equal(list[0].score.features.region.score, 100);
  assert.equal(list.at(-1).score.features.region.score, 0);
  assert.ok(list[0].score.total > list.at(-1).score.total);
  assert.equal(list[0].full_name, '', 'телефоны наружу не отдаются');
  assert.equal(JSON.stringify(list).includes('+7999'), false);

  // Допуск с истёкшим сроком не работает.
  await S.sql`update specialist_permits set valid_until = ${addDays(today, -1)} where user_id = ${b.user.id}`;
  assert.deepEqual((await cands(o)).map((x) => x.user_id), [a.user.id]);
  await S.sql`update specialist_permits set valid_until = null where user_id = ${b.user.id}`;
});

test('специалист не получает собственное дело и дело своей организации', async () => {
  const mine = await submitted('moscow', undefined, a);
  assert.ok(!(await cands(mine)).some((x) => x.user_id === a.user.id));
  assert.equal((await offer(mine, a)).status, 409);
});

test('предложение: без допуска нельзя; со старым «откуда» нельзя; есть история и оценка', async () => {
  const o = await submitted('moscow');
  assert.equal((await offer(o, c)).status, 409, 'нет допуска на эту услугу');
  assert.equal((await offer(o, off)).status, 409, 'не принимает дела');
  assert.equal((await offer(o, a, 'new')).status, 409, 'устаревший статус');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: 'нет', from: 'matching' })).status, 404);
  assert.equal((await offer(o, a)).status, 200);
  const [row] = await S.sql`select * from order_offers where order_id = ${o.id}`;
  assert.equal(row.specialist_id, a.user.id);
  assert.ok(row.score.total > 0 && row.score.features.load);
  assert.equal(row.outcome, null);
  const [st] = await S.sql`select status, executor_user_id from orders where id = ${o.id}`;
  assert.deepEqual([st.status, st.executor_user_id], ['awaiting_executor', a.user.id]);
});

test('переназначение: первый специалист теряет дело, второй получает; отказ и принятие идут в «качество»', async () => {
  const o = await submitted('moscow');
  assert.equal((await offer(o, a)).status, 200);
  assert.equal((await offer(o, b, 'awaiting_executor')).status, 200);
  assert.equal((await a.req('GET', `/api/orders/${o.id}`)).status, 404, 'передано другому — первому дело не видно');
  assert.equal((await b.req('GET', `/api/orders/${o.id}`)).status, 200);
  const offers = await S.sql`select specialist_id, outcome from order_offers where order_id = ${o.id} order by id`;
  assert.deepEqual(offers.map((x) => x.outcome), ['withdrawn', null]);
  // Переназначенное предложение «снято», а не «отказ» — в качество не засчитывается.
  assert.equal((await b.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const [done] = await S.sql`select outcome from order_offers where order_id = ${o.id} and specialist_id = ${b.user.id}`;
  assert.equal(done.outcome, 'accepted');
  // В работе дело уже не предлагается другим.
  assert.equal((await offer(o, a, 'in_work')).status, 409);
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).status, 409);
});

test('отказы снижают качество; загрузка считается по делам в работе', async () => {
  for (let i = 0; i < 3; i++) {
    const o = await submitted('moscow');
    assert.equal((await offer(o, a)).status, 200);
    assert.equal((await a.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'awaiting_executor', reason: 'не успеваю' })).status, 200);
  }
  const o = await submitted('moscow');
  const list = await cands(o);
  const fa = list.find((x) => x.user_id === a.user.id).score.features;
  assert.equal(fa.quality.score, 0, 'три отказа из трёх');
  assert.match(fa.quality.note, /приняты 0 из 3/);
  const fb = list.find((x) => x.user_id === b.user.id).score.features;
  assert.equal(fb.load.score, 80, 'у второго одно дело в работе при норме 5');
  assert.equal(list[0].user_id, b.user.id);
});

test('диспетчер может отдать дело и не первому в списке; исполнитель видит дело в своём списке', async () => {
  const o = await submitted('moscow');
  const list = await cands(o);
  const last = list.at(-1);
  const who = last.user_id === a.user.id ? a : b;
  assert.equal((await offer(o, who)).status, 200);
  const mine = (await who.req('GET', '/api/orders')).body.orders;
  assert.ok(mine.some((x) => x.id === o.id && x.status === 'awaiting_executor'));
});
