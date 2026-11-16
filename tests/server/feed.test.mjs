// Лента заказов эксперта (2.468, решение Дамира 10.11.2026): эксперт сам берёт оплаченный заказ с ценой; заказчик
// эксперта не выбирает. В ленте — только то, что диспетчер мог бы предложить этому эксперту, и в его регионах; без адреса и
// имён. Берёт первый: второму — «уже нет в ленте», дело в работе у первого, заказчику и диспетчеру — уведомления.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { heirFeed, shareFeed } from '../../src/ops/feed-ops.mjs';
import { heirNotices } from '../../src/orders/inheritance.mjs';

let S, owner, dispatcher, a, b, mo, noPermit, plain;
const ADDRESS = 'г. Москва, Лентовая ул., 7, кв. 12';

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990004681');
  dispatcher = await login(S, '+79990004682');
  a = await login(S, '+79990004683');
  b = await login(S, '+79990004684');
  mo = await login(S, '+79990004685'); // только Московская область
  noPermit = await login(S, '+79990004686'); // допуск только на транспорт
  plain = await login(S, '+79990004687'); // не специалист
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, a.user.id);
  await makeSpecialist(S.sql, b.user.id);
  await makeSpecialist(S.sql, mo.user.id, { regions: ['mo'] });
  await makeSpecialist(S.sql, noPermit.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

async function order(title, { paid = true, submit = true, extra = {} } = {}) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: ADDRESS, ...extra };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: addDays(todayMsk(), 10) })).status, 200);
  if (submit) assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  if (paid) await ensurePaid(S.sql, o.id, 1_000_000);
  return o;
}
const feed = async (c) => (await c.req('GET', '/api/specialist/feed')).body;

test('в ленте — оплаченный заказ с ценой, только допущенным и в их регионе, без адреса; выплата эксперту видна', async () => {
  const o = await order('Лента: квартира');
  const draft = await order('Лента: черновик', { paid: false, submit: false });
  const unpaid = await order('Лента: не оплачен', { paid: false });
  const fa = await feed(a);
  const item = fa.feed.find((x) => x.id === o.id);
  assert.ok(item, 'заказ в ленте эксперта');
  assert.ok(!fa.feed.some((x) => x.id === draft.id || x.id === unpaid.id), 'без оплаты и черновики — не в ленте');
  assert.equal(item.service_name, 'Оценка недвижимости');
  assert.equal(item.payout_kop, 800_000, 'эксперту — его выплата');
  assert.ok(item.facts.some((f) => f.value === 'Квартира'), 'вид объекта');
  assert.ok(item.facts.some((f) => f.value === 'Москва'), 'регион');
  assert.ok(!JSON.stringify(fa).includes('Лентовая'), 'адреса в ленте нет');
  assert.ok(!JSON.stringify(fa).includes('Лента: квартира'), 'названия заявки заказчика в ленте нет');
  assert.ok(!(await feed(mo)).feed.some((x) => x.id === o.id), 'другой регион — не видно');
  assert.ok(!(await feed(noPermit)).feed.some((x) => x.id === o.id), 'без допуска — не видно');
  assert.deepEqual((await feed(plain)).feed, [], 'не специалист — пусто');
  assert.ok(!(await feed(owner)).feed.length, 'заказчик ленты не видит');
  // Не принимает дела — ленты нет, и об этом сказано.
  await a.req('PATCH', '/api/specialist/me', { active: false });
  const off = await feed(a);
  assert.equal(off.active, false);
  assert.ok(!off.feed.some((x) => x.id === o.id));
  await a.req('PATCH', '/api/specialist/me', { active: true });
  // Диспетчер предложил заказ кому-то — из ленты ушёл.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: b.user.id, from: 'matching' })).status, 200);
  assert.ok(!(await feed(a)).feed.some((x) => x.id === o.id), 'предложено — не в ленте');
});

test('«Взять заказ»: первый получает дело в работу, второму — «уже нет в ленте»; заказчику и диспетчеру — уведомления', async () => {
  const o = await order('Лента: берём');
  assert.equal((await a.req('GET', `/api/orders/${o.id}`)).status, 404, 'до того как взять, дело закрыто');
  const r = await a.req('POST', `/api/specialist/feed/${o.id}/take`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'in_work');
  const second = await b.req('POST', `/api/specialist/feed/${o.id}/take`);
  assert.equal(second.status, 404);
  assert.match(second.body.message, /взял другой эксперт/);
  const view = (await a.req('GET', `/api/orders/${o.id}`)).body.order;
  assert.equal(view.status, 'in_work');
  assert.equal(view.fields.address, ADDRESS, 'взял — видит заявку целиком');
  assert.equal((await b.req('GET', `/api/orders/${o.id}`)).status, 404);
  const hist = await S.sql`select from_status, to_status, side, reason from order_status_history where order_id = ${o.id} order by id`;
  assert.deepEqual(hist.at(-1), { from_status: 'matching', to_status: 'in_work', side: 'executor', reason: 'Взял из ленты заказов' });
  const [off] = await S.sql`select specialist_id, outcome from order_offers where order_id = ${o.id}`;
  assert.deepEqual(off, { specialist_id: a.user.id, outcome: 'accepted' });
  const ev = async (u) => (await S.sql`select event from notifications where user_id = ${u.user.id} and order_id = ${o.id}`).map((x) => x.event);
  assert.ok((await ev(owner)).includes('accepted'), 'заказчику — исполнитель принял');
  assert.ok((await ev(dispatcher)).includes('feed_taken'), 'диспетчеру — взят из ленты');
  assert.ok(!(await feed(b)).feed.some((x) => x.id === o.id));
});

test('взять нельзя: чужой регион, без допуска, не специалист, заказчик, неоплаченный и несуществующий — «не найдено»', async () => {
  const o = await order('Лента: нельзя');
  const unpaid = await order('Лента: нельзя без оплаты', { paid: false });
  for (const c of [mo, noPermit, plain, owner, dispatcher]) {
    assert.equal((await c.req('POST', `/api/specialist/feed/${o.id}/take`)).status, 404);
  }
  assert.equal((await a.req('POST', `/api/specialist/feed/${unpaid.id}/take`)).status, 404);
  assert.equal((await a.req('POST', '/api/specialist/feed/00000000-0000-4000-8000-000000000000/take')).status, 404);
  const [cur] = await S.sql`select status, executor_user_id from orders where id = ${o.id}`;
  assert.deepEqual(cur, { status: 'matching', executor_user_id: null }, 'заказ остался в подборе');
});

// Прогон 2.509: оценка для наследства в ленте — сколько месяцев назад дата оценки и сколько объектов, без даты и названий.
test('прогон 2.509: в ленте — оценка для наследства на прошлую дату и число объектов, без даты смерти и названий', async () => {
  const o = await order('Лента: наследство', { extra: { purpose: 'inheritance', death_date: '03.02.2025', notary: 'Нотариус Лентова',
    heir_objects: 'Гараж в ГСК «Лентовый»\nАвтомобиль Лада' } });
  const item = (await feed(a)).feed.find((x) => x.id === o.id);
  assert.ok(item, 'заказ в ленте');
  assert.equal(item.heir.objects, 3, 'основной и два других объекта');
  assert.ok(item.heir.months >= 21, 'дата оценки больше 20 месяцев назад');
  const raw = JSON.stringify(item);
  assert.ok(!raw.includes('2025') && !raw.includes('Лентов') && !raw.includes('Гараж'), 'ни даты смерти, ни нотариуса, ни объектов');
});

test('прогон 2.509: месяцы до даты оценки и слова «объект/объекта/объектов»', () => {
  assert.deepEqual(heirFeed({ fields: { purpose: 'inheritance', death_date: '15.03.2026' } }, '2026-11-14'), { months: 7, objects: 1 });
  assert.deepEqual(heirFeed({ fields: { purpose: 'inheritance', death_date: '15.03.2026' } }, '2026-11-15'), { months: 8, objects: 1 });
  assert.deepEqual(heirFeed({ fields: { purpose: 'inheritance' } }, '2026-11-15'), { months: null, objects: 1 });
  assert.equal(heirFeed({ fields: { purpose: 'deal', death_date: '15.03.2026' } }), null);
  const many = Array.from({ length: 20 }, (_, i) => `Объект ${i + 1}`).join('\n');
  assert.match(heirNotices('realty', { purpose: 'inheritance', address: 'А', heir_objects: many })[0].text, /В составе наследства 21 объект:/);
  assert.match(heirNotices('realty', { purpose: 'inheritance', address: 'А', heir_objects: 'Б\nВ\nГ\nД' })[0].text, /5 объектов:/);
});

// 2.516: оценка доли в ленте — размер доли и способ до «Взять заказ»; способ и порядок пользования — в этой строке, а не
// фактами; сведений о собственниках — нет.
test('2.516: в ленте у доли — размер и способ оценки, без сведений о собственниках', async () => {
  const o = await order('Лента: доля', { extra: { object_type: 'share', share_size: '1/3', share_method: 'pro_rata',
    share_use: 'none', share_owners: 'Брат Лентов — 2/3, живёт там' } });
  const item = (await feed(a)).feed.find((x) => x.id === o.id);
  assert.ok(item, 'заказ в ленте');
  assert.deepEqual(item.share, { size: '1/3', method: 'pro_rata', use: 'none', court: false });
  assert.ok(!item.facts.some((f) => /как оценивать/.test(f.label)), 'способ — не отдельным фактом');
  assert.ok(!item.facts.some((f) => /порядок/.test(f.label)), 'порядок пользования — не отдельным фактом');
  assert.ok(!JSON.stringify(item).includes('Лентов'), 'о собственниках — ничего');
  const flat = await order('Лента: не доля', { extra: { object_type: 'flat', share_size: '1/3' } });
  assert.equal((await feed(a)).feed.find((x) => x.id === flat.id).share, null);
});

test('2.516: размер доли только дробью, способ и суд', () => {
  const sh = (fields, service = 'realty') => shareFeed({ service, fields: { object_type: 'share', ...fields } });
  assert.deepEqual(sh({ share_size: ' 1 / 2 ', share_method: 'market' }), { size: '1/2', method: 'market', use: null, court: false });
  assert.deepEqual(sh({ share_size: 'половина', purpose: 'division', share_use: 'court' }), { size: null, method: null, use: 'court', court: true });
  assert.deepEqual(sh({ share_size: '3/2', share_method: 'xx', purpose: 'court' }), { size: null, method: null, use: null, court: true });
  assert.equal(sh({ share_size: '1/3' }, 'vehicle'), null);
});
