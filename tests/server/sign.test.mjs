// Подпись заключения УКЭП и выдача (задача 2.5): эксперт подписывает свой файл результата, пока дело в работе; без подписи
// результат на проверку не сдаётся; подпись проверяется по файлу в хранилище; заказчик получает файл и подпись после проверки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { fakeSign } from '../../src/providers/sign.mjs';

let S, owner, dispatcher, spec;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 15', area: '41' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990001501');
  dispatcher = await login(S, '+79990001502');
  spec = await login(S, '+79990001503');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const result = (o, name = 'Заключение.pdf', body = 'тестовое заключение') => spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(body), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});
const sign = (d, body = { confirm: true }) => spec.req('POST', `/api/documents/${d.id}/sign`, body);
const verify = (c, d) => c.req('POST', `/api/documents/${d.id}/signature/verify`);
const docsOf = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/documents`)).body;

async function inWork(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

test('подпись — в описании модуля: экспертиза требует подпись для всех услуг; без описания — не требуется; ошибка — не стартует', () => {
  const reg = createRegistry();
  for (const s of expertise.services) assert.equal(reg.signatureRequired('expertise', s.id), true, s.id);
  assert.equal(reg.signatureRequired('expertise', 'nope'), false);
  const { signature, ...none } = structuredClone(expertise);
  assert.ok(signature);
  assert.equal(createRegistry([none]).signatureRequired('expertise', 'realty'), false);
  assert.equal(createRegistry([{ ...none, signature: { services: ['goods'] } }]).signatureRequired('expertise', 'realty'), false);
  assert.throws(() => createRegistry([{ ...none, signature: { services: ['нет'] } }]), /подпись/);
  assert.throws(() => createRegistry([{ ...none, signature: { who: 'x' } }]), /подпись/);
});

test('поддельная подпись: верна для своего файла; изменённый файл, чужой ключ, испорченная подпись — неверна', async () => {
  const a = fakeSign('a'.repeat(40));
  const digest = 'ab'.repeat(32);
  const out = await a.sign({ digest, filename: 'x.pdf', signer: { id: 'u1', name: 'Тестов Т. Т.' } });
  assert.equal(out.test, true);
  assert.match(out.signature.toString(), /юридической силы не имеет/);
  assert.equal(out.certificate.subject, 'Тестов Т. Т.');
  assert.equal((await a.verify({ digest, signature: out.signature })).valid, true);
  assert.equal((await fakeSign('a'.repeat(40)).verify({ digest, signature: out.signature })).valid, true, 'другая копия ядра проверяет');
  assert.match((await a.verify({ digest: 'cd'.repeat(32), signature: out.signature })).reason, /изменён/);
  assert.equal((await fakeSign('b'.repeat(40)).verify({ digest, signature: out.signature })).valid, false);
  const forged = Buffer.from(out.signature.toString().replace('Тестов Т. Т.', 'Другой Д. Д.'));
  assert.equal((await a.verify({ digest, signature: forged })).valid, false, 'подменили владельца');
  assert.equal((await a.verify({ digest, signature: Buffer.from('мусор') })).valid, false);
});

test('эксперт подписывает свой результат; без подписи не сдать; заказчик после выдачи видит подпись и проверяет её', async () => {
  const o = await inWork('Квартира для подписи');
  const d = (await result(o)).body.document;
  assert.equal((await docsOf(spec, o)).signature_required, true);
  assert.equal((await docsOf(spec, o)).documents.find((x) => x.id === d.id).signature, null);
  let r = await step(spec, o, 'review');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'not_signed');
  assert.match(r.body.message, /Заключение\.pdf/);

  assert.equal((await sign(d, {})).body.error, 'confirm_required');
  assert.equal((await sign(d)).body.error, 'no_name', 'без имени в профиле подписи нет');
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт Экспертович' })).status, 200);

  // Сбой сервиса подписи — понятная ошибка, ничего не записано.
  S.providers.sign.script({ kind: 'fail', message: 'нет связи' });
  assert.equal((await sign(d)).status, 502);
  S.providers.sign.script();
  assert.equal((await S.sql`select count(*)::int as n from document_signatures where document_id = ${d.id}`)[0].n, 0);

  r = await sign(d);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.signature.signer, 'Тестов Эксперт Экспертович');
  assert.equal(r.body.signature.test, true);
  assert.equal(r.body.signature.checked_ok, true);
  const [audit] = await S.sql`select details from audit_log where action = 'document.sign' and subject_id = ${d.id}`;
  assert.equal(audit.details.test, true);

  // Второй файл без подписи снова не пускает; подписанный и удалённый — не мешает, файл подписи убирается.
  const extra = (await result(o, 'Приложение.pdf')).body.document;
  assert.equal((await step(spec, o, 'review')).body.error, 'not_signed');
  assert.equal((await sign(extra)).status, 201);
  const [sx] = await S.sql`select storage_key from document_signatures where document_id = ${extra.id}`;
  assert.equal((await spec.req('DELETE', `/api/documents/${extra.id}`)).status, 204);
  assert.equal(await S.providers.storage.get(sx.storage_key), null, 'подпись удалённого файла убрана');

  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.equal((await sign(d)).status, 409, 'после сдачи подпись не меняется');
  assert.equal((await docsOf(owner, o)).documents.some((x) => x.kind === 'result'), false, 'до выдачи заказчик не видит');

  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);

  const got = (await docsOf(owner, o)).documents.find((x) => x.id === d.id);
  assert.equal(got.signature.signer, 'Тестов Эксперт Экспертович');
  assert.match(got.signature.issuer, /Тестовый/);
  r = await verify(owner, d);
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, true);
  const link = (await owner.req('GET', `/api/documents/${d.id}/signature/link`)).body.url;
  const file = await owner.req('GET', link);
  assert.equal(file.status, 200);
  assert.match(decodeURIComponent(file.headers.get('content-disposition')), /Заключение\.pdf\.sig/);
  assert.match(JSON.stringify(file.body), /юридической силы не имеет/);

  // Файл в хранилище подменили — проверка показывает «изменён», отметка проверки сохраняется.
  const [doc] = await S.sql`select storage_key from documents where id = ${d.id}`;
  await S.providers.storage.put(doc.storage_key, Buffer.from('подменённый файл'), 'application/pdf');
  r = await verify(owner, d);
  assert.equal(r.body.valid, false);
  assert.match(r.body.reason, /изменён/);
  assert.equal((await docsOf(owner, o)).documents.find((x) => x.id === d.id).signature.checked_ok, false);
});

test('черновик заключения, приложенный файлом Word (2.2), подписывается так же', async () => {
  const o = await inWork('Квартира: черновик и подпись');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { from: null, body: 'Заключение эксперта. Итог: 7 000 000 руб.' })).status, 200);
  const dr = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft;
  const att = await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: dr.id, confirm: true });
  assert.equal(att.status, 201);
  assert.equal((await sign(att.body.document)).status, 201);
  assert.equal((await step(spec, o, 'review')).status, 200);
});
