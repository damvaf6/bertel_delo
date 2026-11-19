// Прогон 2.548 (пачка «Квартира в новостройке: права по ДДУ», 2.539–2.547): дело целиком — заявка с договором, черновик от ИИ,
// эксперт заполняет пропуски, Word, полная ИИ-проверка по тексту Word с договором в деле, итог для сводки руководителя.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { dduDraftValue } from '../../src/orgs/report.mjs';

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', bank: 'sber', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ул. Тестовая, вл. 5, корп. 3',
  ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_complex: 'ЖК «Тестовый», корп. 3',
  ddu_unit: '145', ddu_area: 41.5, ddu_handover: '31.12.2027', ddu_price: 9000000, ddu_finish: 'white' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005990');
  dispatcher = await login(S, '+79990005991');
  spec = await login(S, '+79990005992');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

const put = async (o, text, name) => (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(text), {
  raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } })).body.document;
const CONTRACT = ['ДОГОВОР УЧАСТИЯ В ДОЛЕВОМ СТРОИТЕЛЬСТВЕ № ЖК-12/3-145 от «14» марта 2025 г.',
  'Застройщик: ООО «СЗ Тестовый». Объект долевого строительства — квартира, условный номер 145, проектная общая площадь 41,5 кв. м.',
  'Срок передачи объекта долевого строительства участнику — не позднее 31.12.2027. Цена договора — 9 000 000 руб.',
  'Договор зарегистрирован Управлением Росреестра по г. Москве, номер регистрации 77:01:0001001:1234-77/051/2025-1.'].join('\n');

async function dduCase(fields, ready = async () => {}) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'ДДУ: прогон' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  await ready(o);
  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { o, d: r.body.draft };
}

const PAID = 'Справка. ООО «СЗ Тестовый» подтверждает, что цена по договору участия в долевом строительстве № ЖК-12/3-145 от 14.03.2025 оплачена полностью.';
const fill = (body) => body.replace(/^\| (Сравнительный|Итоговая величина) \| \[заполнить\] \| (?:\[заполнить\]|1) \|$/gm, '| $1 | 9 500 000 | 1 |')
  .replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'текст');

test('полная ИИ-проверка отчёта по ДДУ из Word: договор в деле — без ложных находок; договор в перечне с номером и датой', async () => {
  const { o, d } = await dduCase(BASE, async (o) => { await put(o, CONTRACT, 'Скан 001.txt'); await put(o, PAID, 'Справка об оплате ДДУ.txt'); });
  // Раньше договор в перечне документов — «Документ — файл «Скан 001.txt»», без номера и даты.
  const lines = d.body.split('\n');
  assert.ok(lines.some((l) => /^1\. Договор участия в долевом строительстве № ЖК-12\/3-145 от 14\.03\.2025 — файл «Скан 001\.txt»/u.test(l)), d.body);
  assert.ok(lines.some((l) => /^2\. Документ — файл «Справка об оплате ДДУ\.txt»/u.test(l)), 'справка об оплате — не договор');
  const body = fill(d.body);
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body, from: d.id })).status, 200);
  // Итог только в таблице подходов — сводка руководителя его видит (раньше «итога в черновике нет»).
  assert.equal(dduDraftValue(body), 9500000);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const up = await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(await w.arrayBuffer()), {
    raw: true, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x-file-name': encodeURIComponent('Отчёт.docx') } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  S.providers.ai.reset();
  const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(ai.status, 201, JSON.stringify(ai.body));
  const found = ai.body.ai.items.flatMap((i) => (i.found ?? []).map((f) => `${i.id}: ${f.text}`));
  // Пропуски «текст» вместо разделов — находки о СРО, страховке и т. п. законны; по ДДУ, площади, номерам и суммам — ни одной.
  assert.deepEqual(found.filter((f) => /ДДУ|требовани|кадастров|площад|выписк|ЕГРН|руб\.|не совпада/iu.test(f)), [], found.join('\n'));
});

test('договор по пункту запроса — в перечне названием договора, даже если номер в файле не читается', async () => {
  const { o, d } = await dduCase(BASE);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['ddu_contract'] })).status, 201);
  const put = await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('Скан без распознанного текста'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('scan.txt') } });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const [rq] = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: put.body.document.id })).status, 200);
  const g = await spec.req('POST', `/api/orders/${o.id}/draft/sources`, { from: d.id });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const lines = g.body.draft.body.split('\n');
  assert.ok(lines.includes('1. Договор участия в долевом строительстве — файл «scan.txt», получен ' + todayMsk().split('-').reverse().join('.')),
    lines.filter((l) => /^\d+\. /u.test(l)).join('\n'));
});

test('не ДДУ (квартира): документ с договором долевого участия — как раньше, по названию из запроса или «Документ»', async () => {
  const { d } = await dduCase({ ...BASE, object_type: 'flat' }, (o) => put(o, CONTRACT, 'Скан 001.txt'));
  assert.ok(d.body.split('\n').some((l) => /^1\. Документ — файл «Скан 001\.txt»/u.test(l)), d.body);
});
