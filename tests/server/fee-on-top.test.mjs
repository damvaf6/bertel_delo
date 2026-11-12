// Экспертиза (2.463, схема 5 экранов — решение Дамира 31.10/02.11.2026): вознаграждение платформы 20% СВЕРХ цены эксперта —
// диспетчер назначает цену эксперта, заказчик платит её ×1,2, эксперт получает 100% своей цены; выплата эксперту — вручную,
// списком «Выплатить вручную», отметку «выплачено» ставит диспетчер. Переводы — по-прежнему 80/20 из цены заказчика.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, signResults, makeOrg, addMember } from '../helpers.mjs';
import { priceOnTop, splitAmount } from '../../src/money/money.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import translation from '../../src/modules/translation.mjs';

let S, owner, dispatcher, spec;
const READY = { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 3' } };
const step = (c, o, to, from, reason, extra = {}) => c.req('POST', `/api/orders/${o.id}/status`, { to, from, reason, ...extra });
const money = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/money`)).body.money;

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000651');
  dispatcher = await login(S, '+79990000652');
  spec = await login(S, '+79990000653');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { capacity: 50 });
});
after(async () => { await S?.close(); });

async function paidInWork(price) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Сверх цены эксперта' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work', 'awaiting_executor')).status, 200);
  return o;
}

test('расчёт сверх цены эксперта: ×1,2 с округлением до копейки, эксперту — вся его цена', () => {
  assert.equal(priceOnTop(400_000), 480_000, 'от 4 000 ₽ — заказчику 4 800 ₽');
  assert.equal(priceOnTop(600_050), 720_060);
  assert.equal(priceOnTop(1_003), 1_204, '20% от 10,03 ₽ = 2,006 ₽ → 2,01 ₽');
  for (const e of [100, 101, 333, 999_999, 600_050]) {
    const s = splitAmount(priceOnTop(e), 0, e);
    assert.equal(s.payoutKop, e, 'эксперту — 100% его цены');
    assert.equal(s.commissionKop + s.payoutKop, priceOnTop(e));
    assert.equal(s.onTop, true);
  }
  assert.equal(splitAmount(1_000_000).onTop, undefined, 'без цены эксперта — прежнее 80/20');
});

test('описание модуля: экспертиза — сверх цены и вручную, переводы — как прежде; ошибка в money — сервер не стартует', () => {
  const reg = createRegistry();
  assert.deepEqual(reg.money('expertise'), { on_top: true, manual: true, invoice: true });
  assert.deepEqual(reg.money('translation'), { on_top: false, manual: false, invoice: false });
  assert.throws(() => validateModule({ ...expertise, money: { fee: 'inside' } }), /fee/);
  assert.throws(() => validateModule({ ...expertise, money: { payout: 'auto' } }), /payout/);
  assert.throws(() => validateModule({ ...expertise, money: { fee: 'on_top', extra: 1 } }));
  assert.equal(translation.money, undefined);
});

test('выдача: эксперту его цена — в списке «Выплатить вручную», поставщику выплата не уходит; диспетчер отмечает «выплачено»', async () => {
  const o = await paidInWork('12000');
  const md = await money(dispatcher, o);
  assert.deepEqual([md.expert_kop, md.price_kop, md.fee_kop, md.commission_kop, md.fee_on_top], [1_200_000, 1_440_000, 1_200_000, 240_000, true]);
  const mo = await money(owner, o);
  assert.deepEqual([mo.price_kop, mo.expert_kop, mo.fee_kop], [1_440_000, null, null], 'заказчик видит только свою цену');
  assert.equal((await money(spec, o)).fee_kop, 1_200_000, 'эксперт — свою цену');

  // Поставщик откажет в любой выплате — но выплата вручную к нему и не идёт.
  S.providers.payments.payoutOutcome = 'failed';
  try {
    assert.equal((await S.sql`select 1 from payouts where order_id = ${o.id}`).length, 0);
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } })).status, 201);
    await signResults(S, spec, o.id);
    assert.equal((await step(spec, o, 'review', 'in_work')).status, 200);
    const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
    for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
    assert.equal((await step(dispatcher, o, 'done', 'review')).status, 200);
  } finally { S.providers.payments.payoutOutcome = 'succeeded'; }
  const [p] = await S.sql`select amount_kop, commission_kop, status, manual, attempts, provider_id from payouts where order_id = ${o.id}`;
  assert.deepEqual([Number(p.amount_kop), Number(p.commission_kop), p.status, p.manual, p.attempts, p.provider_id], [1_200_000, 240_000, 'pending', true, 0, null]);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payout/retry`)).status, 409, 'повтор через поставщика — не для выплаты вручную');

  const sum = (await dispatcher.req('GET', '/api/money')).body;
  const row = sum.manual.find((x) => x.order_id === o.id);
  assert.deepEqual([row.amount_kop, row.executor_phone, row.manual], [1_200_000, '+79990000653', true]);
  assert.ok(sum.manual_kop >= 1_200_000);
  // Документы: акт заказчику и отчёт агента — с ценой эксперта и вознаграждением сверх неё.
  const [act] = (await money(owner, o)).documents;
  assert.deepEqual([act.data.price_kop, act.data.payout_kop, act.data.commission_kop, act.data.fee_on_top], [1_440_000, 1_200_000, 240_000, true]);

  const r = await dispatcher.req('POST', `/api/orders/${o.id}/payout/paid`, { note: '  платёжка   № 42 ' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.money.payout.status, r.body.money.payout.manual_note], ['succeeded', 'платёжка № 42']);
  const ms = await money(spec, o);
  assert.deepEqual([ms.payout.status, ms.payout.amount_kop], ['succeeded', 1_200_000]);
  const n = await S.sql`select event from notifications where user_id = ${spec.user.id} and order_id = ${o.id} and event = 'payout_succeeded'`;
  assert.equal(n.length, 1, 'эксперту — «выплачено»');
  assert.ok(!(await dispatcher.req('GET', '/api/money')).body.manual.some((x) => x.order_id === o.id));
});

test('отказ заказчика после начала работ: эксперту — та же доля его цены, платформе — 20% сверх неё, остальное — заказчику', async () => {
  const o = await paidInWork('10000');
  assert.equal((await step(dispatcher, o, 'cancelled', 'in_work', 'Заказчик отказался', { fault: 'customer', done_percent: 40 })).status, 200);
  const [p] = await S.sql`select amount_kop, commission_kop, status, manual from payouts where order_id = ${o.id}`;
  assert.deepEqual([Number(p.amount_kop), Number(p.commission_kop), p.status, p.manual], [400_000, 80_000, 'pending', true]);
  const [r] = await S.sql`select amount_kop from refunds where order_id = ${o.id}`;
  assert.equal(Number(r.amount_kop), 720_000, 'из 12 000 ₽ — 4 800 ₽ за сделанную часть, 7 200 ₽ заказчику');
});

// Ночной прогон 12.11.2026: у руководителя организации в «Делах экспертов» вознаграждение считалось как 80% цены заказчика
// (19 200 ₽ → 15 360 ₽), потому что выборка дел не брала цену эксперта. Теперь — цена эксперта целиком, и в «Ждёт выдачи».
test('дела экспертов у руководителя: вознаграждение и «ждёт выдачи» — цена эксперта, а не 80% цены заказчика', async () => {
  const head = await login(S, '+79990000654');
  const org = await makeOrg(S.sql, 'Бюро сверх цены');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, spec.user.id, 'member');
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${spec.user.id}`;
  try {
    const before = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.money.waiting_kop;
    const o = await paidInWork('16000');
    const r = await head.req('GET', `/api/orgs/${org.id}/cases`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.cases.find((x) => x.id === o.id);
    assert.equal(c.fee_kop, 1_600_000, 'вознаграждение — вся цена эксперта');
    assert.equal(r.body.money.waiting_kop - before, 1_600_000, '«Ждёт выдачи» выросло на цену эксперта, а не на 80% цены заказчика');
  } finally {
    await S.sql`update specialists set org_id = null where user_id = ${spec.user.id}`;
  }
});
