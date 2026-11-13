// Товароведческая экспертиза — заявка (задача 2.480): что за товар, модель и серийный номер, недостатки построчно, когда
// обнаружен, гарантийный срок, проверял ли продавец. Гарантия на дату обнаружения — подсказкой в деле всем, кто видит
// заявку (`notices`); только факты по датам, без выводов о праве.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login } from '../helpers.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { warrantyEnd, warrantyOf, warrantyNotices } from '../../src/orders/warranty.mjs';

let S, owner, stranger;
const FIELDS = { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться', questions: 'Есть ли недостаток?',
  purchase: '12.03.2026, магазин, 54 990 ₽', goods_kind: 'gadget', model: 'Тестовый ноутбук X1, s/n TEST0001',
  defects: 'не включается\nтрещина на крышке', found_date: '20.04.2026', warranty_months: 12, seller_check: 'denied' };

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004801');
  stranger = await login(S, '+79990004802');
});
after(async () => { await S?.close(); });

test('конец гарантии — то же число через N месяцев, нет числа — последний день месяца', () => {
  assert.equal(warrantyEnd('2026-03-12', 12), '2027-03-12');
  assert.equal(warrantyEnd('2026-01-31', 1), '2026-02-28');
  assert.equal(warrantyEnd('2026-11-30', 3), '2027-02-28');
  assert.equal(warrantyEnd('2028-01-31', 1), '2028-02-29');
  assert.equal(warrantyEnd('2026-05-05', 24), '2028-05-05');
});

test('гарантия на дату обнаружения: в сроке, после, без гарантии, даты не сходятся', () => {
  const today = '2026-11-13';
  assert.equal(warrantyOf(FIELDS, today).state, 'in');
  assert.deepEqual(warrantyNotices('goods', FIELDS, today), [{ id: 'warranty_in',
    text: 'Недостаток обнаружен 20.04.2026 — в гарантийный срок (гарантия 12 мес. с 12.03.2026 — до 12.03.2027).' }]);
  const late = { ...FIELDS, warranty_months: 1 };
  assert.match(warrantyNotices('goods', late, today)[0].text, /^Недостаток обнаружен 20\.04\.2026 — после гарантийного срока \(гарантия 1 мес\. с 12\.03\.2026 — до 12\.04\.2026\)\.$/);
  // В последний день гарантии — ещё в сроке.
  assert.equal(warrantyOf({ ...FIELDS, warranty_months: 1, found_date: '12.04.2026' }, today).state, 'in');
  assert.equal(warrantyNotices('goods', { ...FIELDS, warranty_months: 0 }, today)[0].text, 'Гарантии на товар нет (куплен 12.03.2026). Недостаток обнаружен 20.04.2026.');
  assert.match(warrantyNotices('goods', { ...FIELDS, found_date: '01.03.2026' }, today)[0].text, /раньше даты покупки .*проверьте даты/);
  assert.match(warrantyNotices('goods', { ...FIELDS, found_date: '01.12.2026' }, today)[0].text, /ещё не наступила/);
  // Даты обнаружения нет — по сегодняшнему дню.
  const { found_date: _, ...noFound } = FIELDS;
  assert.equal(warrantyNotices('goods', noFound, today)[0].text, 'Гарантийный срок не кончился: гарантия 12 мес. с 12.03.2026 — до 12.03.2027.');
  assert.equal(warrantyNotices('goods', noFound, '2027-03-13')[0].text, 'Гарантийный срок кончился: гарантия 12 мес. с 12.03.2026 — до 12.03.2027.');
  // Считать не из чего — молчим; другая услуга — молчим.
  const { warranty_months: __, ...noTerm } = FIELDS;
  assert.deepEqual(warrantyNotices('goods', noTerm, today), []);
  assert.deepEqual(warrantyNotices('goods', { ...FIELDS, purchase: 'в магазине' }, today), []);
  assert.deepEqual(warrantyNotices('goods', { ...FIELDS, found_date: '31.02.2026' }, today).map((n) => n.id), ['warranty_in'], 'нет такой даты — как без даты');
  assert.deepEqual(warrantyNotices('realty', FIELDS, today), []);
  // Выводов о праве нет.
  for (const f of [FIELDS, late, noFound]) assert.ok(!/возврат|верн|обязан|закон|прав/i.test(warrantyNotices('goods', f, today)[0].text));
});

test('новые поля — в описании услуги и необязательны', () => {
  const reg = createRegistry([expertise]);
  const ids = reg.service('expertise', 'goods').service.fields.map((f) => f.id);
  for (const id of ['goods_kind', 'model', 'defects', 'found_date', 'warranty_months', 'seller_check']) assert.ok(ids.includes(id), id);
  const req = reg.service('expertise', 'goods').service.fields.filter((f) => f.required).map((f) => f.id);
  assert.deepEqual(req, ['subject', 'questions']);
});

test('заявка: поля сохраняются, подсказка о гарантии видна в деле, неверная дата — ошибка', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'goods', title: 'Ноутбук: гарантия' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { fields: FIELDS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const view = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  const got = view.order;
  assert.equal(got.fields.defects, FIELDS.defects);
  assert.equal(got.fields.warranty_months, 12);
  assert.equal(got.fields.seller_check, 'denied');
  assert.deepEqual(view.notices.map((n) => n.id), ['warranty_in']);
  assert.equal(view.quote, null, 'у экспертизы цены по таблице нет');
  const bad = await owner.req('PATCH', `/api/orders/${o.id}`, { fields: { ...FIELDS, found_date: '2026-04-20' } });
  assert.equal(bad.status, 400);
  const bad2 = await owner.req('PATCH', `/api/orders/${o.id}`, { fields: { ...FIELDS, goods_kind: 'cars' } });
  assert.equal(bad2.status, 400);
  // Чужой заявку не видит.
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}`)).status, 404);
});
