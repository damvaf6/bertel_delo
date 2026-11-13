// Готовые фразы эксперта заказчику по товару (задача 2.486): чек и договор, гарантийный талон, претензия и ответ продавца,
// акт проверки качества, «не ремонтируйте товар» — данными в описании модуля (phrases). Получен документ по запросу — фразы
// нет; продавец товар не проверял — нет фразы об акте проверки; выбор из заявки — названием варианта. Отправляет эксперт сам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'court', region: 'moscow', subject: 'Телефон не включается', goods_kind: 'gadget',
  model: 'Тестофон 5, IMEI 000000000000001', defects: 'не включается', found_date: '14.09.2026', warranty_months: 12,
  seller_check: 'denied', questions: 'Есть ли недостатки?', location: 'у заказчика, г. Москва', purchase: '12.03.2026, Тестовый магазин, 54 990 ₽' };
const G = ['g_receipt', 'g_warranty', 'g_claim', 'g_quality', 'g_keep'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004861');
  dispatcher = await login(S, '+79990004862');
  spec = await login(S, '+79990004863');
  stranger = await login(S, '+79990004864');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'goods']] });
});
after(async () => { await S?.close(); });

async function inWork(fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'goods', title: 'Товар: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}

test('фразы по товару — только у товароведческой; чек, проверка и местонахождение из заявки', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'goods');
  const now = new Date('2026-10-06T21:30:00Z');
  const all = messagePhrases({ def, fields: FIELDS, now });
  assert.deepEqual(all.map((p) => p.id), ['access', 'address', 'docs', ...G]);
  assert.deepEqual(all.slice(3).map((p) => p.title),
    ['Чек и договор', 'Гарантийный талон', 'Претензия и ответ продавца', 'Акт проверки качества', 'Не ремонтируйте товар']);
  for (const p of all.slice(3, 7)) {
    assert.match(p.text, /до 12 октября/, p.id);
    assert.match(p.text, /Приложить можно в деле или ответом здесь\.$/, p.id);
  }
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  assert.match(all[3].text, /В заявке указано: «12\.03\.2026, Тестовый магазин, 54 990 ₽»/);
  // Выбор из заявки — названием варианта, не кодом.
  assert.match(all[6].text, /В заявке указано: «Да — сказали, что виноват покупатель»/);
  assert.ok(!all[6].text.includes('denied'));
  // «Не ремонтируйте» — без документа: без «Приложить можно», с местом из заявки, без «до …».
  assert.match(all[7].text, /не ремонтируйте товар[\s\S]*В заявке указано: «у заказчика, г\. Москва»\.$/);
  assert.ok(!/Приложить можно/.test(all[7].text));
  // Продавец не проверял — фразы об акте проверки нет; не указано — есть, без «В заявке указано».
  const no = messagePhrases({ def, fields: { ...FIELDS, seller_check: 'no' }, now });
  assert.ok(!no.some((p) => p.id === 'g_quality'));
  const bare = messagePhrases({ def, fields: {}, now });
  assert.deepEqual(bare.slice(3).map((p) => p.id), G);
  assert.ok(!bare.slice(3).some((p) => /В заявке указано/.test(p.text)));
  // Запрошен — к пункту; получен — фразы нет (талон и претензия — один пункт).
  const asked = messagePhrases({ def, fields: FIELDS, now, docItems: { quality_check: 'open', warranty: 'got' } });
  assert.deepEqual(asked.map((p) => p.id), ['access', 'address', 'docs', 'g_receipt', 'g_quality', 'g_keep']);
  assert.match(asked[4].text, /к пункту «Акт проверки качества или заключение сервисного центра» списка «Запрошенные документы»\.$/);
  // У других услуг этих фраз нет; у ДТП фразы прежние.
  for (const s of ['vehicle', 'realty', 'movable', 'car_damage']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: {} }).some((p) => p.id.startsWith('g_')), s);
  }
});

test('skip у фразы проверяется при запуске (2.486)', () => {
  const bad = (phrases) => assert.throws(() => validateModule({ ...expertise, phrases }), undefined, JSON.stringify(phrases));
  const ok = { id: 'x', title: 'Т', services: ['goods'], field: 'seller_check', skip: ['no'], text: 'Текст' };
  validateModule({ ...expertise, phrases: [ok] });
  bad([{ ...ok, skip: [] }]);
  bad([{ ...ok, skip: ['nope'] }]);
  bad([{ ...ok, skip: 'no' }]);
  bad([{ ...ok, field: undefined }]);
  bad([{ ...ok, field: 'purchase' }]);
});

test('в деле по товару: фразы у эксперта; полученный документ — без фразы; заказчик и чужой не видят', async () => {
  const o = await inWork();
  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs', ...G]);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['purchase', 'warranty'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'g_receipt').text, /к пункту «Чек или договор покупки»/);
  const reqs = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  const w = reqs.find((x) => x.item_id === 'warranty');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('скан'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('талон.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${w.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs', 'g_receipt', 'g_quality', 'g_keep']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
