// Замечания к сданному отчёту (задача 2.431): после «готово» заказчик пишет, что пришли замечания от банка или суда, и
// прикладывает файл замечаний; дело снова у того же эксперта, срок ответа — 3 рабочих дня (описание модуля), без второй выплаты.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { addDays, availableActions, findTransition, todayMsk } from '../../src/orders/workflow.mjs';
import { workdaysAfter } from '../../src/orders/holidays.mjs';
import expertise from '../../src/modules/expertise.mjs';
import translation from '../../src/modules/translation.mjs';

let S, owner, dispatcher, spec, other;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 31', area: '44' };

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004311');
  dispatcher = await login(S, '+79990004312');
  spec = await login(S, '+79990004313');
  other = await login(S, '+79990004314');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function step(c, o, to, extra = {}) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...extra });
}
const upload = (c, o, path, name, kind) => c.req('POST', `/api/orders/${o.id}/${path}`, Buffer.from(`%PDF ${name}`), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name), ...(kind ? { 'x-doc-kind': kind } : {}) },
});

async function doneOrder(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  assert.equal((await upload(spec, o, 'results', 'Отчёт.pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  const r = await step(dispatcher, o, 'done');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return o;
}

test('замечания — в описании модуля: у экспертизы 3 рабочих дня, у переводов нет; ошибка в описании — не стартует', () => {
  const reg = createRegistry();
  assert.deepEqual(reg.remarks('expertise'), { reply_days: 3 });
  assert.equal(reg.remarks('translation'), null);
  const { remarks, ...none } = structuredClone(expertise);
  assert.ok(remarks);
  assert.throws(() => createRegistry([{ ...none, remarks: { reply_days: 0 } }]), /reply_days/);
  assert.throws(() => createRegistry([{ ...none, remarks: { reply_days: 3, extra: 1 } }]), /замечания/);
  assert.throws(() => createRegistry([{ ...structuredClone(translation), remarks: { reply_days: 3 } }]), /proofread/);
  // Шаг — только с признаком модуля: у переводов после выдачи — своя переделка.
  assert.equal(findTransition('done', 'in_work', ['customer']), null);
  assert.equal(findTransition('done', 'in_work', ['customer'], ['remarks'])?.name, 'Пришли замечания к отчёту');
  assert.equal(findTransition('done', 'in_work', ['customer'], ['redo'])?.name, 'Нашли ошибку — переделать бесплатно');
  assert.ok(availableActions('done', ['customer'], ['remarks']).some((a) => a.to === 'in_work' && a.remarks && a.reason));
});

test('рабочие дни после: выходные и праздники не в счёт', () => {
  assert.equal(workdaysAfter('2026-10-28', 3), '2026-11-02');
  assert.equal(workdaysAfter('2026-10-30', 3), '2026-11-05', '4 ноября — праздник');
  assert.equal(workdaysAfter('2026-12-30', 1), '2027-01-11', 'новогодние каникулы');
});

test('пришли замечания к отчёту: файл и текст, дело снова у эксперта, срок ответа 3 рабочих дня, без второй выплаты', async () => {
  const o = await doneOrder('Квартира: замечания банка');
  const view = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.ok(view.actions.some((a) => a.to === 'in_work' && a.name === 'Пришли замечания к отчёту' && a.remarks));
  assert.ok(!view.actions.some((a) => a.name === 'Нашли ошибку — переделать бесплатно'), 'у экспертизы — не переделка переводов');
  assert.equal(view.remarks, null);
  // Диспетчер и эксперт такой кнопки не видят — замечания приносит заказчик.
  assert.ok(!(await dispatcher.req('GET', `/api/orders/${o.id}`)).body.actions.some((a) => a.to === 'in_work'));
  assert.ok(!(await spec.req('GET', `/api/orders/${o.id}`)).body.actions.some((a) => a.to === 'in_work'));
  assert.equal((await step(spec, o, 'in_work', { reason: 'x' })).status, 403);

  // Текст обязателен; файл замечаний — документ этого дела.
  assert.equal((await step(owner, o, 'in_work')).body.error, 'reason_required');
  const file = await upload(owner, o, 'documents', 'Замечания банка.pdf');
  assert.equal(file.status, 201, JSON.stringify(file.body));
  const otherOrder = (await other.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Чужое' })).body.order;
  const foreign = await upload(other, otherOrder, 'documents', 'Чужой файл.pdf');
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк просит пояснить аналоги', document_id: foreign.body.document.id })).status, 404);
  const [res] = await S.sql`select id from documents where order_id = ${o.id} and kind = 'result'`;
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк просит пояснить аналоги', document_id: res.id })).status, 404, 'файл результата — не замечания');

  const r = await step(owner, o, 'in_work', { reason: 'Банк просит пояснить выбор аналогов и корректировку на торг', document_id: file.body.document.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const due = workdaysAfter(todayMsk(), 3);
  const [row] = await S.sql`select status, executor_user_id, remarks_due, remarks_round, remarks_doc_id, proofread, deadline from orders where id = ${o.id}`;
  assert.equal(row.status, 'in_work');
  assert.equal(row.executor_user_id, spec.user.id, 'дело у того же эксперта');
  assert.equal(row.remarks_due, due);
  assert.equal(row.remarks_round, 1);
  assert.equal(row.remarks_doc_id, file.body.document.id);
  assert.equal(row.proofread, null, 'не переделка переводов');
  assert.ok(row.deadline >= due, 'срок дела — не раньше срока ответа');

  // Эксперт, заказчик и диспетчер видят замечания: когда, срок ответа, текст и файл.
  for (const c of [spec, owner, dispatcher]) {
    const rm = (await c.req('GET', `/api/orders/${o.id}`)).body.remarks;
    assert.equal(rm.due, due);
    assert.equal(rm.open, true);
    assert.equal(rm.round, 1);
    assert.match(rm.text, /аналогов/);
    assert.equal(rm.document.filename, 'Замечания банка.pdf');
  }
  assert.equal((await other.req('GET', `/api/orders/${o.id}`)).status, 404, 'чужому — нет');
  const notes = await S.sql`select user_id, event from notifications where order_id = ${o.id} and event in ('remarks', 'remarks_staff')`;
  assert.ok(notes.some((n) => n.event === 'remarks' && n.user_id === spec.user.id));
  assert.ok(notes.some((n) => n.event === 'remarks_staff' && n.user_id === dispatcher.user.id));
  assert.ok(!notes.some((n) => n.user_id === owner.user.id), 'тому, кто сделал шаг, — нет');

  // Эксперт исправляет, подписывает и сдаёт; после «готово» замечания закрыты, вторая выплата не появляется.
  assert.equal((await upload(spec, o, 'results', 'Отчёт (исправленный).pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  const after = (await owner.req('GET', `/api/orders/${o.id}`)).body.remarks;
  assert.equal(after.open, false);
  const pays = await S.sql`select count(*)::int as n from payouts where order_id = ${o.id}`;
  assert.equal(pays[0].n, 1, 'ответ на замечания — без второй выплаты');

  // Пришли новые замечания (второй круг) — без файла тоже можно.
  assert.equal((await step(owner, o, 'in_work', { reason: 'Суд просит письменные пояснения' })).status, 200);
  const rm2 = (await spec.req('GET', `/api/orders/${o.id}`)).body.remarks;
  assert.equal(rm2.round, 2);
  assert.equal(rm2.document, null);
  assert.match(rm2.text, /Суд/);
});
