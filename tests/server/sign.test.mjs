// Подпись заключения УКЭП и выдача (задача 2.5): эксперт подписывает свой файл результата, пока дело в работе; без подписи
// результат на проверку не сдаётся; подпись проверяется по файлу в хранилище; заказчик получает файл и подпись после проверки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { fakeSign, testExternalSignature, testGoskeySignature } from '../../src/providers/sign.mjs';

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
const result = (o, name = 'Заключение.pdf', body = 'тестовое заключение', who = spec) => who.req('POST', `/api/orders/${o.id}/results`, Buffer.from(body), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});
const sign = (d, body = { confirm: true }, who = spec) => who.req('POST', `/api/documents/${d.id}/sign`, body);
const verify = (c, d) => c.req('POST', `/api/documents/${d.id}/signature/verify`);
const docsOf = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/documents`)).body;

async function inWork(title, who = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(who, o, 'in_work')).status, 200);
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
  assert.equal((await docsOf(spec, o)).documents.find((x) => x.id === d.id).signatures.expert, null);
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
  assert.equal(got.signatures.expert.signer, 'Тестов Эксперт Экспертович');
  assert.match(got.signatures.expert.issuer, /Тестовый/);
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
  assert.equal((await docsOf(owner, o)).documents.find((x) => x.id === d.id).signatures.expert.checked_ok, false);
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

test('готовая подпись «из программы УЦ» (2.5а): верна для своего файла; подделка, чужой файл, испорченная — неверна', async () => {
  const a = fakeSign('a'.repeat(40));
  const digest = 'ab'.repeat(32);
  const ext = testExternalSignature({ digest, subject: 'Внешний В. В.', org: 'ООО «Тест»' });
  const r = await a.verify({ digest, signature: ext });
  assert.equal(r.valid, true);
  assert.deepEqual([r.certificate.subject, r.certificate.org, r.certificate.title, r.test], ['Внешний В. В.', 'ООО «Тест»', 'Руководитель', true]);
  assert.match(ext.toString(), /юридической силы не имеет/);
  assert.match((await a.verify({ digest: 'cd'.repeat(32), signature: ext })).reason, /изменён/);
  const forged = Buffer.from(ext.toString().replace('Внешний В. В.', 'Другой Д. Д.'));
  assert.equal((await a.verify({ digest, signature: forged })).valid, false, 'подменили владельца');
  // Своя подпись кабинета с меткой «внешней» не проходит по открытому ключу.
  const own = JSON.parse((await a.sign({ digest, filename: 'x', signer: { id: 'u', name: 'Т' } })).signature.toString());
  assert.equal((await fakeSign('b'.repeat(40)).verify({ digest, signature: Buffer.from(JSON.stringify({ ...own, mark: 'ТЕСТОВАЯ ВНЕШНЯЯ ПОДПИСЬ — юридической силы не имеет' })) })).valid, false);
});

test('две подписи (2.5а): эксперт работает от организации — подписывает ещё руководитель; заказчик видит и проверяет обе', async () => {
  const org = await makeOrg(S.sql, 'ООО «Тестовая оценка»');
  const head = await login(S, '+79990001504');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const spec = await login(S, '+79990001506');
  await makeSpecialist(S.sql, spec.user.id);
  await addMember(S.sql, org.id, spec.user.id, 'member');
  assert.equal((await head.req('PATCH', '/api/me', { full_name: 'Руководитель Тестовой Оценки' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт Экспертович' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  {
    const o = await inWork('Квартира: две подписи', spec);
    const body = 'заключение для двух подписей';
    const d = (await result(o, 'Отчёт.pdf', body, spec)).body.document;
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    assert.equal((await docsOf(spec, o)).signature_org, org.name);
    // Эксперт загружает готовую подпись — руководителю приходит уведомление.
    const up = await spec.req('POST', `/api/documents/${d.id}/signature/upload`, testExternalSignature({ digest, subject: 'Тестов Эксперт Экспертович' }),
      { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-confirm': '1' } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const n = (await head.req('GET', '/api/notifications')).body.notifications;
    assert.ok(n.some((x) => /нужна подпись организации/.test(x.title)), 'руководитель получил уведомление');
    let r = await step(spec, o, 'review');
    assert.equal(r.body.error, 'not_signed_org');
    assert.match(r.body.message, /Тестовая оценка.*Отчёт\.pdf/);
    // 2.36: в «Делах экспертов» у дела видно, что файл ждёт подписи организации.
    const cs = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases;
    assert.deepEqual(cs.map((c) => [c.sign_wait, c.returned_open]), [[1, false]]);
    const list = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].executor, 'Тестов Эксперт Экспертович');
    assert.equal(list[0].service, 'Оценка недвижимости');
    assert.ok(!JSON.stringify(list).includes('две подписи'), 'название заявки (текст заказчика) руководителю не показывается');
    assert.equal(list[0].documents[0].signatures.expert.method, 'upload');
    assert.equal((await head.req('POST', `/api/org-documents/${d.id}/sign`, {})).body.error, 'confirm_required');
    assert.equal((await head.req('POST', `/api/org-documents/${d.id}/sign`, { confirm: true })).status, 201);
    assert.equal((await step(spec, o, 'review')).status, 200);
    const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
    for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
    assert.equal((await step(dispatcher, o, 'done')).status, 200);
    const got = (await docsOf(owner, o)).documents.find((x) => x.id === d.id).signatures;
    assert.equal(got.expert.signer, 'Тестов Эксперт Экспертович');
    assert.equal(got.org.signer, 'Руководитель Тестовой Оценки');
    assert.equal(got.org.org, org.name);
    r = await verify(owner, d);
    assert.equal(r.body.valid, true);
    assert.equal(r.body.signatures.org.checked_ok, true);
    const link = (await owner.req('GET', `/api/documents/${d.id}/signature/link?role=org`)).body.url;
    const file = await owner.req('GET', link);
    assert.match(decodeURIComponent(file.headers.get('content-disposition')), /Отчёт\.pdf\.org\.sig/);
    // Подмена файла — обе подписи «неверна».
    const [doc] = await S.sql`select storage_key from documents where id = ${d.id}`;
    await S.providers.storage.put(doc.storage_key, Buffer.from('подменённый'), 'application/pdf');
    r = await verify(owner, d);
    assert.equal(r.body.valid, false);
    assert.equal(r.body.signatures.org.checked_ok, false);
    assert.equal(r.body.signatures.expert.checked_ok, false);
  }
});

test('ушёл из организации — подпись организации больше не нужна; руководитель её дел не видит', async () => {
  const org = await makeOrg(S.sql, 'ООО «Бывшая оценка»');
  const head = await login(S, '+79990001505');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const spec = await login(S, '+79990001507');
  await makeSpecialist(S.sql, spec.user.id);
  await addMember(S.sql, org.id, spec.user.id, 'member');
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Бывший Сотрудник' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${spec.user.id}`;
  {
    assert.equal((await spec.req('GET', '/api/specialist/me')).body.specialist.org, null);
    const o = await inWork('Квартира: без организации', spec);
    const d = (await result(o, 'Итог.pdf', undefined, spec)).body.document;
    assert.equal((await docsOf(spec, o)).signature_org, null);
    assert.equal((await sign(d, undefined, spec)).status, 201);
    assert.deepEqual((await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items, []);
    assert.equal((await head.req('GET', `/api/org-documents/${d.id}/link`)).status, 404);
    assert.equal((await step(spec, o, 'review')).status, 200, 'хватает подписи эксперта');
  }
});

test('возврат эксперту (2.27): руководитель возвращает файл с замечанием до своей подписи — подпись эксперта снимается', async () => {
  const org = await makeOrg(S.sql, 'ООО «Возвратная оценка»');
  const head = await login(S, '+79990001508');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const spec = await login(S, '+79990001509');
  await makeSpecialist(S.sql, spec.user.id);
  await addMember(S.sql, org.id, spec.user.id, 'member');
  assert.equal((await head.req('PATCH', '/api/me', { full_name: 'Руководитель Возвратов' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Возвратов' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const o = await inWork('Квартира: возврат', spec);
  const d = (await result(o, 'Отчёт 7.pdf', 'первая версия', spec)).body.document;
  const ret = (comment) => head.req('POST', `/api/org-documents/${d.id}/return`, { comment });
  assert.equal((await ret('рано')).body.error, 'not_signed', 'неподписанный файл не возвращается');
  assert.equal((await sign(d, undefined, spec)).status, 201);
  assert.equal((await ret('')).status, 400);
  assert.equal((await ret('x'.repeat(2001))).status, 400);
  const r = await ret('Раздел 5: проверьте корректировку на торг.\nИтог не совпадает с таблицей.');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Подпись эксперта снята, файл подписи остался в хранилище (для истории).
  const docs = await docsOf(spec, o);
  assert.equal(docs.documents.find((x) => x.id === d.id).signatures.expert, null);
  const [row] = await S.sql`select signature_key from org_returns where id = ${r.body.return.id}`;
  assert.ok(await S.providers.storage.get(row.signature_key), 'файл подписи не удалён');
  assert.equal(docs.org_returns.length, 1);
  assert.deepEqual([docs.org_returns[0].open, docs.org_returns[0].by, docs.org_returns[0].org, docs.org_returns[0].filename],
    [true, 'Руководитель Возвратов', org.name, 'Отчёт 7.pdf']);
  assert.match(docs.org_returns[0].comment, /Итог не совпадает/);
  // Эксперту — уведомление по делу; заказчику и диспетчеру — ничего.
  const n = (await spec.req('GET', '/api/notifications')).body.notifications;
  assert.ok(n.some((x) => /вернул отчёт с замечанием/.test(x.title) && x.order_id === o.id), 'эксперт получил уведомление');
  for (const c of [owner, dispatcher]) {
    assert.ok(!(await c.req('GET', '/api/notifications')).body.notifications.some((x) => /вернул отчёт/.test(x.title)));
    assert.equal((await docsOf(c, o)).org_returns, undefined);
  }
  const [{ n: audits }] = await S.sql`select count(*)::int as n from audit_log where action = 'document.org_return' and subject_id = ${d.id}`;
  assert.equal(audits, 1);
  // Без подписи эксперта не сдать и организации не подписать.
  assert.equal((await step(spec, o, 'review')).body.error, 'not_signed');
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/sign`, { confirm: true })).body.error, 'expert_first');
  // История у руководителя: ждём исправления.
  let item = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items.find((x) => x.documents.some((y) => y.id === d.id));
  assert.equal(item.returns.length, 1);
  assert.equal(item.returns[0].open, true);
  // Эксперт удаляет старый файл и кладёт новый — замечание закрыто; подписывает новый.
  assert.equal((await spec.req('DELETE', `/api/documents/${d.id}`)).status, 204);
  const d2 = (await result(o, 'Отчёт 7 (исправлен).pdf', 'вторая версия', spec)).body.document;
  assert.equal((await docsOf(spec, o)).org_returns[0].open, false);
  assert.equal((await sign(d2, undefined, spec)).status, 201);
  // Второй возврат — уже нового файла; эксперт подписывает его заново, не меняя.
  assert.equal((await head.req('POST', `/api/org-documents/${d2.id}/return`, { comment: 'Нет подписи на титуле' })).status, 201);
  let rs = (await docsOf(spec, o)).org_returns;
  assert.deepEqual(rs.map((x) => x.open), [false, true]);
  assert.equal((await sign(d2, undefined, spec)).status, 201);
  rs = (await docsOf(spec, o)).org_returns;
  assert.deepEqual(rs.map((x) => x.open), [false, false]);
  // После подписи организации вернуть нельзя; после сдачи — тоже.
  assert.equal((await head.req('POST', `/api/org-documents/${d2.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await head.req('POST', `/api/org-documents/${d2.id}/return`, { comment: 'поздно' })).body.error, 'already_signed');
  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.equal((await head.req('POST', `/api/org-documents/${d2.id}/return`, { comment: 'поздно' })).status, 409);
  // Диспетчер на проверке возвратов не видит.
  assert.ok(!JSON.stringify((await docsOf(dispatcher, o))).includes('титуле'));
});

test('замечания по пунктам (2.93): эксперт отмечает исправленные, руководитель до новой подписи видит, что осталось', async () => {
  const org = await makeOrg(S.sql, 'ООО «Пункты оценки»');
  const head = await login(S, '+79990001512');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const spec = await login(S, '+79990001513');
  await makeSpecialist(S.sql, spec.user.id);
  await addMember(S.sql, org.id, spec.user.id, 'member');
  assert.equal((await head.req('PATCH', '/api/me', { full_name: 'Руководитель Пунктов' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Пунктов' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const o = await inWork('Квартира: пункты', spec);
  const d = (await result(o, 'Отчёт 8.pdf', 'первая версия', spec)).body.document;
  assert.equal((await sign(d, undefined, spec)).status, 201);
  const r = await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: '1. Раздел 5: корректировка на торг.\n\n2) Итог не совпадает с таблицей\n- Нет подписи на титуле' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.return.items.map((x) => x.text), ['Раздел 5: корректировка на торг.', 'Итог не совпадает с таблицей', 'Нет подписи на титуле']);
  const rid = r.body.return.id;
  let mine = (await docsOf(spec, o)).org_returns[0];
  assert.deepEqual([mine.items.length, mine.left, mine.document_id], [3, 3, d.id]);
  const mark = (c, n, fixed, id = rid) => c.req('PUT', `/api/orders/${o.id}/org-returns/${id}/items/${n}`, { fixed });
  // Отмечает только исполнитель; номер пункта и возврата — только свои.
  assert.equal((await mark(owner, 1, true)).status, 403);
  assert.equal((await mark(dispatcher, 1, true)).status, 403);
  assert.equal((await mark(head, 1, true)).status, 404, 'руководитель заявку не видит');
  assert.equal((await mark(spec, 4, true)).status, 404);
  assert.equal((await mark(spec, 'x', true)).status, 404);
  assert.equal((await mark(spec, 1, true, 999999)).status, 404);
  assert.equal((await mark(spec, 1, 'да')).status, 400);
  const m = await mark(spec, 1, true);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.return.left, 2);
  assert.equal((await mark(spec, 3, true)).body.return.left, 1);
  assert.equal((await mark(spec, 3, false)).body.return.left, 2, 'отметку можно снять');
  assert.equal((await mark(spec, 3, true)).body.return.left, 1);
  const [{ n: audits }] = await S.sql`select count(*)::int as n from audit_log where action like 'org_return.item_%' and subject_id = ${o.id}`;
  assert.equal(audits, 4);
  // Руководитель видит отметки, пока эксперт не подписал заново.
  let item = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items.find((x) => x.documents.some((y) => y.id === d.id));
  assert.deepEqual(item.returns[0].items.map((x) => x.fixed), [true, false, true]);
  assert.deepEqual([item.returns[0].left, item.returns[0].document_id, item.returns[0].open], [1, d.id, true]);
  // 2.151: в «Делах экспертов» — когда вернул и сколько пунктов эксперт уже отметил исправленными.
  let cs = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.equal(cs.returned_open, true);
  assert.deepEqual([cs.returned.items, cs.returned.fixed], [3, 2]);
  assert.ok(Math.abs(new Date(cs.returned.at) - new Date(r.body.return.at)) < 1000);
  // Эксперт подписал заново, не отметив пункт 2: возврат закрыт, отметки больше не меняются; руководитель видит, что осталось.
  assert.equal((await sign(d, undefined, spec)).status, 201);
  assert.equal((await mark(spec, 2, true)).body.error, 'return_closed');
  item = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items.find((x) => x.documents.some((y) => y.id === d.id));
  assert.deepEqual([item.returns[0].open, item.returns[0].left], [false, 1]);
  assert.equal(item.returns[0].items.find((x) => !x.fixed).text, 'Итог не совпадает с таблицей');
  cs = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.deepEqual([cs.returned_open, cs.returned], [false, null]);
  // Заказчик и диспетчер пунктов не видят.
  for (const c of [owner, dispatcher]) assert.ok(!JSON.stringify(await docsOf(c, o)).includes('титуле'));
  // Больше 30 пунктов в одном возврате нельзя.
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: Array.from({ length: 31 }, (_, i) => `п${i}`).join('\n') })).body.error, 'too_many_items');
});

// Распаковка ZIP (архив дела, документ Word) и текст документа Word.
function unzip(buf) {
  const out = new Map();
  for (let p = 0; buf.readUInt32LE(p) === 0x04034b50;) {
    const method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const body = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    out.set(buf.subarray(p + 30, p + 30 + nlen).toString('utf8'), method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 30 + nlen + xlen + csize;
  }
  return out;
}
const docText = (docx) => unzip(docx).get('word/document.xml').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('все способы подписи одним прогоном (2.69): эксперт и руководитель — в кабинете, готовым файлом, «Госключ»; заказчик проверяет каждую; протокол в архиве', async () => {
  const org = await makeOrg(S.sql, 'ООО «Все способы»');
  const head = await login(S, '+79990001510');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const spec = await login(S, '+79990001511');
  await makeSpecialist(S.sql, spec.user.id);
  await addMember(S.sql, org.id, spec.user.id, 'member');
  assert.equal((await head.req('PATCH', '/api/me', { full_name: 'Руководитель Всех Способов' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Всех Способов' })).status, 200);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const o = await inWork('Квартира: все способы подписи', spec);
  const raw = { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-confirm': '1' } };
  const bodies = { 'Отчёт.pdf': 'отчёт — подпись в кабинете', 'Приложение 1.pdf': 'приложение — готовая подпись УЦ', 'Приложение 2.pdf': 'приложение — «Госключ»' };
  const d = {};
  for (const [name, body] of Object.entries(bodies)) d[name] = (await result(o, name, body, spec)).body.document;
  const digest = (name) => crypto.createHash('sha256').update(bodies[name]).digest('hex');

  // Эксперт: три способа.
  assert.equal((await sign(d['Отчёт.pdf'], undefined, spec)).status, 201);
  let r = await spec.req('POST', `/api/documents/${d['Приложение 1.pdf'].id}/signature/upload`, testExternalSignature({ digest: digest('Приложение 1.pdf'), subject: 'Эксперт Всех Способов' }), raw);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.signature.app, null);
  // «Госключ» для чужого файла — отказ; для своего — принят, видно, что из «Госключа».
  r = await spec.req('POST', `/api/documents/${d['Приложение 2.pdf'].id}/signature/upload`, testGoskeySignature({ digest: digest('Отчёт.pdf'), subject: 'Эксперт Всех Способов' }), raw);
  assert.equal(r.body.error, 'bad_signature');
  assert.match(r.body.message, /Файл изменён после подписи/);
  r = await spec.req('POST', `/api/documents/${d['Приложение 2.pdf'].id}/signature/upload`, testGoskeySignature({ digest: digest('Приложение 2.pdf'), subject: 'Эксперт Всех Способов' }), raw);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.signature.method, r.body.signature.app, r.body.signature.test], ['upload', 'Госключ', true]);
  assert.match(r.body.signature.issuer, /Госключ/);

  // Руководитель: в кабинете, готовым файлом с сертификатом организации; «Госключ» (сертификат физлица) — понятный отказ.
  assert.equal((await head.req('POST', `/api/org-documents/${d['Отчёт.pdf'].id}/sign`, { confirm: true })).status, 201);
  r = await head.req('POST', `/api/org-documents/${d['Приложение 1.pdf'].id}/signature/upload`,
    testExternalSignature({ digest: digest('Приложение 1.pdf'), subject: 'Руководитель Всех Способов', org: org.name }), raw);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await head.req('POST', `/api/org-documents/${d['Приложение 2.pdf'].id}/signature/upload`,
    testGoskeySignature({ digest: digest('Приложение 2.pdf'), subject: 'Руководитель Всех Способов' }), raw);
  assert.equal(r.body.error, 'not_org_certificate');
  assert.match(r.body.message, /из приложения «Госключ» — это подпись физического лица — для подписи организации нужен сертификат организации/);
  assert.equal((await head.req('POST', `/api/org-documents/${d['Приложение 2.pdf'].id}/sign`, { confirm: true })).status, 201);

  // Сдача, проверка, выдача.
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);

  // Заказчик видит, как подписан каждый файл, и проверяет каждый.
  const got = new Map((await docsOf(owner, o)).documents.filter((x) => x.kind === 'result').map((x) => [x.filename, x.signatures]));
  assert.deepEqual([...got.keys()].sort(), Object.keys(bodies).sort());
  assert.deepEqual(Object.keys(bodies).map((n) => [got.get(n).expert.method, got.get(n).expert.app, got.get(n).org.method]),
    [['cabinet', null, 'cabinet'], ['upload', null, 'upload'], ['upload', 'Госключ', 'cabinet']]);
  for (const name of Object.keys(bodies)) {
    r = await verify(owner, d[name]);
    assert.equal(r.body.valid, true, name);
    assert.equal(r.body.signatures.expert.signer, 'Эксперт Всех Способов');
    assert.equal(r.body.signatures.org.org, org.name);
  }

  // Архив дела: подписи и протокол их проверки — все шесть верны.
  let files = unzip((await owner.req('GET', `/api/orders/${o.id}/export`, undefined, { binary: true })).body);
  const pname = [...files.keys()].find((n) => /^Протокол проверки подписей № [0-9A-F]{8}\.docx$/.test(n));
  assert.ok(pname, [...files.keys()].join(', '));
  for (const n of Object.keys(bodies)) for (const s of ['.sig', '.org.sig']) assert.ok(files.has(`Документы/${n}${s}`), n + s);
  let t = docText(files.get(pname));
  assert.match(t, /Подписей: 6; верны: 6\./);
  assert.equal(t.match(/Подпись верна/g).length, 6);
  assert.match(t, /Приложение 2\.pdf — подпись эксперта .*готовым файлом из приложения «Госключ»/);
  assert.match(t, /Приложение 1\.pdf — подпись организации .*ООО «Все способы» — руководитель Руководитель Всех Способов .*готовым файлом из программы удостоверяющего центра/);
  assert.match(t, /Отчёт\.pdf — подпись эксперта .*в кабинете «БЕРТЕЛ Дело»/);
  assert.match(t, new RegExp(digest('Приложение 2.pdf')));
  assert.match(t, /Тестовые подписи площадки — юридической силы не имеют/);
  assert.match(docText([...files].find(([n]) => n.startsWith('Карточка дела'))[1]), /Протокол проверки подписей № [0-9A-F]{8}\.docx/);

  // Файл подменили в хранилище — протокол честно пишет, что обе его подписи не прошли.
  const [doc] = await S.sql`select storage_key from documents where id = ${d['Приложение 1.pdf'].id}`;
  await S.providers.storage.put(doc.storage_key, Buffer.from('подменённое приложение'), 'application/pdf');
  files = unzip((await owner.req('GET', `/api/orders/${o.id}/export`, undefined, { binary: true })).body);
  t = docText(files.get([...files.keys()].find((n) => n.startsWith('Протокол'))));
  assert.match(t, /Подписей: 6; верны: 4; не прошли проверку: 2\./);
  assert.equal(t.match(/Не прошла: Файл изменён после подписи/g).length, 2);

  // Выгружает дело заказчик или платформа — исполнитель нет.
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/export`)).status, 403);
});

test('напоминание перед подписью (2.136): ИИ-проверку файла не запускали, проверяли прежнюю версию, есть пункты «посмотрите» — видно только исполнителю', async () => {
  const o = await inWork('Квартира — ИИ перед подписью');
  const reg = createRegistry();
  const rules = reg.checks('expertise', 'realty');
  const d1 = (await result(o, 'Отчёт v1.docx.txt', 'отчёт первая версия')).body.document;
  const hint = async (who, d) => (await docsOf(who, o)).documents.find((x) => x.id === d.id)?.ai_check;
  assert.deepEqual(await hint(spec, d1), { state: 'none', other: false });
  assert.equal(await hint(dispatcher, d1), undefined, 'диспетчеру — без напоминания');

  const orig = S.providers.ai.complete;
  const answer = (bad) => async () => ({ model: 'fake', text: JSON.stringify({ items: rules.map((r) => ({ id: r.id, hint: bad.includes(r.id) ? 'attention' : 'ok', note: bad.includes(r.id) ? 'не совпадает' : 'в порядке' })) }) });
  try {
    S.providers.ai.complete = answer(['requisites', 'object_match']);
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
    const h = await hint(spec, d1);
    assert.equal(h.state, 'attention');
    assert.equal(h.count, 2);
    assert.deepEqual(h.titles, rules.filter((r) => ['requisites', 'object_match'].includes(r.id)).map((r) => r.title.split(':')[0].trim()));

    // Новая версия файла — прежняя проверка её не касается.
    const d2 = (await result(o, 'Отчёт v2.docx.txt', 'отчёт вторая версия')).body.document;
    assert.deepEqual(await hint(spec, d2), { state: 'none', other: true });

    S.providers.ai.complete = answer([]);
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
    assert.equal(await hint(spec, d2), null, 'проверено, замечаний нет — напоминания нет');

    // Подсказка, не запрет: подписать можно; у подписанного — напоминания нет.
    assert.equal((await spec.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт Экспертович' })).status, 200);
    assert.equal((await sign(d1)).status, 201);
    assert.equal(await hint(spec, d1), undefined);
  } finally { S.providers.ai.complete = orig; }
});
