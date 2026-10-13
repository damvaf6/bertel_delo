// Подписанный результат при ручной проверке (задача штаба 3f817197-…-81ac, SIGN_PROVIDER=manual): исполнитель подписывает
// файл своей КЭП где угодно и загружает файл подписи; платформа хранит оба, разбирает сертификат, ключей не хранит; подпись
// проверяет сотрудник платформы на Госуслугах и ставит отметку «подписано КЭП, проверено» (или «не подтвердилась» с причиной).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { cmsInfo } from '../../src/providers/cms.mjs';
import { manualSign, testExternalSignature } from '../../src/providers/sign.mjs';
import { loadConfig } from '../../src/config.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const DOC = fs.readFileSync(new URL('cms-test.txt', FIX));
const SIG = fs.readFileSync(new URL('cms-test.txt.sig', FIX));
const SIG_PEM = fs.readFileSync(new URL('cms-test.txt.pem.sig', FIX));
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 15', area: '41' };

let S, owner, dispatcher, admin, spec;
before(async () => {
  S = await startApp({ SIGN_PROVIDER: 'manual' });
  owner = await login(S, '+79990001601');
  dispatcher = await login(S, '+79990001602');
  spec = await login(S, '+79990001603');
  admin = await login(S, '+79990001604');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await makeSpecialist(S.sql, spec.user.id);
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Иванов Иван Иванович' })).status, 200);
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const result = (o, who = spec, name = 'Заключение.pdf') => who.req('POST', `/api/orders/${o.id}/results`, DOC, {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});
const upload = (d, sig = SIG, who = spec, path = 'documents') => who.req('POST', `/api/${path}/${d.id}/signature/upload`, sig,
  { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-confirm': '1' } });
const check = (who, d, body) => who.req('POST', `/api/documents/${d.id}/signature/check`, body);
const docsOf = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/documents`)).body;
const docOf = async (c, o, d) => (await docsOf(c, o)).documents.find((x) => x.id === d.id);

async function inWork(title, who = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(who, o, 'in_work')).status, 200);
  return o;
}
async function toReview(o) {
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
}

test('файл подписи разбирается: двоичный и текстом — владелец, издатель, срок; не подпись — нет', async () => {
  for (const sig of [SIG, SIG_PEM]) {
    const { certificate } = cmsInfo(sig);
    assert.equal(certificate.subject, 'Иванов Иван Иванович');
    assert.equal(certificate.org, 'ООО «Тестовая оценка»');
    assert.equal(certificate.title, 'Оценщик');
    assert.match(certificate.valid_to, /^\d{4}-\d\d-\d\d$/);
    assert.match(certificate.serial, /^[0-9A-F]+$/);
  }
  for (const junk of [Buffer.from('просто текст, не подпись'), DOC, Buffer.from([0x30, 0x82, 0xff, 0xff, 1, 2, 3]), Buffer.alloc(0),
    testExternalSignature({ digest: 'ab'.repeat(32), subject: 'x' })]) assert.equal(cmsInfo(junk), null);
  const v = await manualSign().verify({ digest: 'ab'.repeat(32), signature: SIG });
  assert.deepEqual([v.valid, v.manual, v.test], [true, true, false]);
  assert.match((await manualSign().verify({ digest: 'x', signature: Buffer.from('мусор') })).reason, /не файл открепленной подписи/);
  // Ручная проверка — настоящий режим: на демо-площадке подпись только поддельная.
  assert.throws(() => loadConfig({ APP_ENV: 'demo', DATABASE_URL: 'postgres://x@localhost/x', SIGN_PROVIDER: 'manual', APP_SECRET: 'x'.repeat(40), DEMO_RESET_KEY: 'y'.repeat(40) }), /sign/);
});

test('исполнитель загружает файл и .sig; в кабинете не подписать; диспетчер отмечает «проверено» — только тогда выдача', async () => {
  const o = await inWork('Квартира: ручная проверка подписи');
  const d = (await result(o)).body.document;
  const before = await docsOf(spec, o);
  assert.equal(before.sign_mode, 'manual');
  assert.equal(before.can_check_signature, undefined, 'исполнитель не отмечает');
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).body.error, 'cabinet_off');
  assert.equal((await upload(d, Buffer.from('не подпись'))).body.error, 'bad_signature');
  const up = await upload(d);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.signature.manual_check, 'pending');
  assert.equal(up.body.signature.signer, 'Иванов Иван Иванович');
  assert.equal(up.body.signature.checked_ok, false);
  assert.equal(up.body.signature.test, false);
  const [row] = await S.sql`select provider, method, storage_key from document_signatures where document_id = ${d.id}`;
  assert.deepEqual([row.provider, row.method], ['manual', 'upload']);
  assert.deepEqual(await S.providers.storage.get(row.storage_key), SIG, 'файл подписи хранится как есть');

  // Проверить подпись до отметки — «ещё не проверена».
  let v = (await spec.req('POST', `/api/documents/${d.id}/signature/verify`)).body;
  assert.equal(v.valid, false);
  assert.match(v.reason, /ещё не проверена платформой на Госуслугах/);

  // Сдать можно; выдать, пока не отмечено, — нельзя.
  await toReview(o);
  assert.equal((await docsOf(dispatcher, o)).can_check_signature, true);
  let r = await step(dispatcher, o, 'done');
  assert.equal(r.body.error, 'signature_unchecked');
  assert.match(r.body.message, /Госуслугах.*Заключение\.pdf/);

  // Отмечает только сотрудник платформы; «не подтвердилась» — только с причиной.
  assert.equal((await check(spec, d, { role: 'expert', ok: true })).status, 403);
  assert.equal((await check(owner, d, { role: 'expert', ok: true })).status, 404);
  assert.equal((await check(dispatcher, d, { role: 'expert' })).body.error, 'bad_ok');
  assert.equal((await check(dispatcher, d, { role: 'expert', ok: false })).body.error, 'note_required');
  assert.equal((await check(dispatcher, d, { role: 'org', ok: true })).body.error, 'not_signed');
  r = await check(dispatcher, d, { role: 'expert', ok: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.signature.manual_check, 'ok');
  assert.equal(r.body.signature.checked_ok, true);
  assert.equal((await check(admin, d, { role: 'expert', ok: true })).body.error, 'already_checked', 'дважды не отметить');
  const [a] = await S.sql`select actor_id, details from audit_log where action = 'signature.check' and subject_id = ${d.id}`;
  assert.equal(a.actor_id, dispatcher.user.id);
  assert.equal(a.details.ok, true);

  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  const got = await docOf(owner, o, d);
  assert.equal(got.signatures.expert.manual_check, 'ok');
  assert.equal(got.signatures.expert.signer, 'Иванов Иван Иванович');
  v = (await owner.req('POST', `/api/documents/${d.id}/signature/verify`)).body;
  assert.equal(v.valid, true);
  assert.equal((await owner.req('GET', `/api/documents/${d.id}/signature/link`)).status, 200, 'заказчик скачивает .sig');
});

test('подпись не подтвердилась: исполнителю уведомление с причиной, сдать нельзя, новая подпись заменяет прежнюю', async () => {
  const o = await inWork('Квартира: подпись не подтвердилась');
  const d = (await result(o)).body.document;
  assert.equal((await upload(d)).status, 201);
  const [first] = await S.sql`select storage_key from document_signatures where document_id = ${d.id}`;
  const r = await check(dispatcher, d, { role: 'expert', ok: false, note: 'Госуслуги: подпись не соответствует файлу' });
  assert.equal(r.status, 200);
  assert.equal(r.body.signature.manual_check, 'bad');
  assert.equal(r.body.signature.manual_note, 'Госуслуги: подпись не соответствует файлу');
  const n = (await spec.req('GET', '/api/notifications')).body.notifications;
  assert.ok(n.some((x) => /не подтвердилась/.test(x.title)), 'исполнитель получил уведомление');
  const seen = await docOf(spec, o, d);
  assert.equal(seen.signatures.expert.manual_note, 'Госуслуги: подпись не соответствует файлу');
  const s = await step(spec, o, 'review');
  assert.equal(s.body.error, 'signature_bad');
  // Загрузил заново — прежний файл подписи убран, снова ждёт проверки, сдать можно.
  const again = await upload(d, SIG_PEM);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.signature.manual_check, 'pending');
  assert.equal(await S.providers.storage.get(first.storage_key), null, 'прежняя подпись удалена из хранилища');
  assert.equal((await upload(d)).body.error, 'already_signed', 'ждущую проверки не заменить');
  assert.equal((await step(spec, o, 'review')).status, 200);
});

test('файл изменён после подписи — отметить нельзя; эксперт от организации: подпись организации тоже загрузкой и отметкой', async () => {
  const o = await inWork('Квартира: файл подменили');
  const d = (await result(o)).body.document;
  assert.equal((await upload(d)).status, 201);
  const [doc] = await S.sql`select storage_key from documents where id = ${d.id}`;
  await S.providers.storage.put(doc.storage_key, Buffer.from('другой файл'), 'application/pdf');
  assert.equal((await check(dispatcher, d, { role: 'expert', ok: true })).body.error, 'file_changed');
  assert.match((await dispatcher.req('POST', `/api/documents/${d.id}/signature/verify`)).body.reason, /изменён после подписи/);

  const org = await makeOrg(S.sql, 'ООО «Тестовая оценка»');
  const head = await login(S, '+79990001605');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const spec2 = await login(S, '+79990001606');
  await makeSpecialist(S.sql, spec2.user.id);
  await addMember(S.sql, org.id, spec2.user.id, 'member');
  assert.equal((await spec2.req('PATCH', '/api/me', { full_name: 'Петров Пётр' })).status, 200);
  assert.equal((await spec2.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const o2 = await inWork('Квартира: организация', spec2);
  const d2 = (await result(o2, spec2)).body.document;
  assert.equal((await upload(d2, SIG, spec2)).status, 201);
  const list = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body;
  assert.equal(list.sign_mode, 'manual');
  assert.equal((await head.req('POST', `/api/org-documents/${d2.id}/sign`, { confirm: true })).body.error, 'cabinet_off');
  const up = await upload(d2, SIG_PEM, head, 'org-documents');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.signature.manual_check, 'pending');
  assert.equal((await step(spec2, o2, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o2.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o2.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await check(dispatcher, d2, { role: 'expert', ok: true })).status, 200);
  assert.equal((await step(dispatcher, o2, 'done')).body.error, 'signature_unchecked', 'подпись организации ещё не отмечена');
  assert.equal((await check(dispatcher, d2, { role: 'org', ok: true })).status, 200);
  assert.equal((await step(dispatcher, o2, 'done')).status, 200);
});
