// Сертификат платформы к переводу без нотариуса (задача 2а.5, задача штаба 3f617197): выдаёт переводчик к своему файлу
// перевода; номер, QR со ссылкой, открытая страница проверки (номер, дата, языки, ФИО переводчика, отпечаток файла).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, client } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { qrMatrix, qrPng } from '../../src/docs/qr.mjs';
import { codeFrom, languagesText, newCode } from '../../src/translation/certificate.mjs';
import { unzip } from '../../src/docs/docx.mjs';

let S, dispatcher, owner, stranger, tr, tr2;
const soon = addDays(todayMsk(), 7);
const FILE = Buffer.from('%PDF-1.4 тестовый перевод паспорта');
const SHA = crypto.createHash('sha256').update(FILE).digest('hex');
const BASE = { recipient: 'business', language: 'en', direction: 'to_ru', doc_kind: 'contract', docs: 1, pages: 2 };

before(async () => {
  S = await startApp();
  dispatcher = await login(S, '+79990000970');
  owner = await login(S, '+79990000971');
  stranger = await login(S, '+79990000972');
  tr = await login(S, '+79990000973');
  tr2 = await login(S, '+79990000974');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, tr.user.id, { permits: [['translation', 'plain'], ['translation', 'notary_paper']], capacity: 20, taxStatus: 'self_employed', languages: ['en'] });
  await S.sql`update dossier_items set number = 'ТД-001' where user_id = ${tr.user.id}`;
  await S.sql`update users set full_name = 'Тестова Переводчица Ивановна' where id = ${tr.user.id}`;
  // Второй переводчик — без проверенного документа о знании немецкого.
  await makeSpecialist(S.sql, tr2.user.id, { permits: [['translation', 'plain']], taxStatus: 'ip', languages: ['en'] });
  await S.sql`update users set full_name = 'Тестов Второй' where id = ${tr2.user.id}`;
});
after(async () => { await S?.close(); });

async function order(service, fields, who = tr) {
  const o = (await owner.req('POST', '/api/orders', { module: 'translation', service, title: `Перевод ${service}` })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  const off = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}
const upload = async (c, o, buf = FILE, name = 'перевод.pdf') => {
  const r = await c.req('POST', `/api/orders/${o.id}/results`, buf, { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.document;
};

test('QR: матрица по стандарту — угловые узоры, размер по длине ссылки; PNG читается', () => {
  const m = qrMatrix('https://delo.example/proverka.html#ABCDEFGHJKLM');
  assert.equal(m.length, 33, 'версия 4 — 33×33');
  const finder = [[1, 1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 0, 1], [1, 0, 1, 1, 1, 0, 1]];
  for (const [r, row] of finder.entries()) assert.deepEqual(m[r].slice(0, 7).map(Number), row);
  assert.equal(m[m.length - 8][8], true, 'тёмный модуль');
  assert.equal(qrMatrix('a').length, 21);
  assert.equal(qrMatrix('x'.repeat(200)).length, 57, 'версия 10');
  assert.throws(() => qrMatrix('x'.repeat(300)), /слишком длинный/);
  const png = qrPng('a', 2);
  assert.equal(png.readUInt32BE(16), (21 + 8) * 2);
  const idat = png.indexOf('IDAT');
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(raw.length, (58 + 1) * 58);
});

test('код проверки и языки словами', () => {
  const c = newCode();
  assert.match(c, /^[A-Z2-9]{12}$/);
  assert.equal(codeFrom(` ${c.slice(0, 4).toLowerCase()}-${c.slice(4, 8)}-${c.slice(8)} `), c);
  assert.equal(codeFrom('ABC'), null);
  assert.equal(codeFrom('ABCDEFGHIJK1'), null, 'I и 1 в коде не бывает');
  assert.equal(languagesText({ language: 'Английский', direction: 'to_ru' }), 'с английского на русский');
  assert.equal(languagesText({ language: 'Иврит', direction: 'to_ru' }), 'с иврита на русский');
  assert.equal(languagesText({ language: 'Немецкий', direction: 'from_ru' }), 'с русского на немецкий');
});

test('сертификат: выдаёт переводчик к своему файлу без нотариуса; страница проверки — открытая, без лишнего', async () => {
  const o = await order('plain', { ...BASE, urgent: 'no', delivery: 'none' });
  const doc = await upload(tr, o);
  const list = (await tr.req('GET', `/api/orders/${o.id}/documents`)).body.documents.find((d) => d.id === doc.id);
  assert.equal(list.can_certify, true);
  assert.equal(list.certificate, null);

  // Чужие не выдают: заказчик (результат ещё не виден), диспетчер, посторонний, другой переводчик.
  for (const c of [owner, stranger, tr2]) assert.equal((await c.req('POST', `/api/documents/${doc.id}/certificate`)).status, 404);
  assert.equal((await dispatcher.req('POST', `/api/documents/${doc.id}/certificate`)).status, 403);

  const r = await tr.req('POST', `/api/documents/${doc.id}/certificate`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const cert = r.body.certificate;
  assert.match(cert.number, new RegExp(`^П-${new Date().getFullYear()}-\\d{6}$`));
  assert.match(cert.code, /^[A-Z2-9]{12}$/);
  assert.ok(cert.url.endsWith(`/proverka.html#${cert.code}`));
  assert.equal(cert.revoked, false);
  // Повтор — тот же сертификат.
  const again = await tr.req('POST', `/api/documents/${doc.id}/certificate`);
  assert.equal(again.status, 200);
  assert.equal(again.body.certificate.number, cert.number);
  const [log] = await S.sql`select action, details from audit_log where action = 'certificate.issue' and subject_id = ${doc.id}`;
  assert.equal(log.details.number, cert.number);

  // Страница проверки: без входа; только номер, дата, языки, переводчик, отпечаток.
  const anon = client(S);
  const chk = await anon.req('GET', `/api/certificates/${cert.code.toLowerCase()}`);
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  assert.deepEqual(Object.keys(chk.body.certificate).sort(), ['issued_at', 'languages', 'number', 'sha256', 'state', 'translator']);
  assert.equal(chk.body.certificate.sha256, SHA);
  assert.equal(chk.body.certificate.languages, 'с английского на русский');
  assert.equal(chk.body.certificate.translator, 'Тестова Переводчица Ивановна');
  assert.equal(chk.body.certificate.state, 'valid');
  assert.ok(!JSON.stringify(chk.body).includes('перевод.pdf'), 'имени файла нет');
  assert.equal((await anon.req('GET', '/api/certificates/AAAAAAAAAAAA')).status, 404);
  assert.equal((await anon.req('GET', `/api/certificates/${encodeURIComponent(cert.number)}`)).status, 404, 'по номеру не находится');

  // Лист Word: переводчику — да; заказчику — после проверки; постороннему — нет.
  const sheet = await tr.req('GET', `/api/documents/${doc.id}/certificate`, undefined, { binary: true });
  assert.equal(sheet.status, 200);
  assert.match(decodeURIComponent(sheet.headers.get('content-disposition')), /Сертификат П-/);
  const files = unzip(sheet.body);
  const xml = files.find((f) => f.name === 'word/document.xml').data.toString('utf8');
  for (const t of [`Сертификат перевода № ${cert.number}`, 'квалификация переводчика проверена', 'Тестова Переводчица Ивановна',
    'с английского на русский', SHA, 'перевод.pdf', 'Тестовый диплом № ТД-001', `${cert.code.slice(0, 4)}-${cert.code.slice(4, 8)}-${cert.code.slice(8)}`]) {
    assert.ok(xml.includes(t), `на листе: ${t}`);
  }
  assert.ok(files.some((f) => f.name === 'word/media/delo1.png'), 'QR картинкой');
  assert.equal((await owner.req('GET', `/api/documents/${doc.id}/certificate`, undefined, { binary: true })).status, 404, 'до проверки заказчику не виден');
  assert.equal((await stranger.req('GET', `/api/documents/${doc.id}/certificate`, undefined, { binary: true })).status, 404);

  assert.equal((await tr.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' })).status, 200);
  const mine = (await owner.req('GET', `/api/orders/${o.id}/documents`)).body.documents.find((d) => d.id === doc.id);
  assert.equal(mine.certificate.number, cert.number);
  assert.equal(mine.can_certify, undefined);
  assert.equal((await owner.req('GET', `/api/documents/${doc.id}/certificate`, undefined, { binary: true })).status, 200);
  // Сданный — новый сертификат уже не выдаётся (дело не в работе), прежний остаётся.
  assert.equal((await tr.req('POST', `/api/documents/${doc.id}/certificate`)).status, 409, 'дело уже не в работе');
});

test('сертификат: не к нотариальному переводу; без проверенного документа о языке; без ФИО; удалили файл — отозван', async () => {
  const paper = await order('notary_paper', { ...BASE, recipient: 'mvd', urgent: 'no', original: 'courier', delivery: 'pickup' });
  const pd = await upload(tr, paper);
  const r1 = await tr.req('POST', `/api/documents/${pd.id}/certificate`);
  assert.equal(r1.status, 409);
  assert.match(r1.body.message, /не выдаётся/);
  assert.equal((await tr.req('GET', `/api/orders/${paper.id}/documents`)).body.documents.find((d) => d.id === pd.id).can_certify, undefined);

  // Немецкий: у второго переводчика проверенного документа нет.
  const de = await order('plain', { ...BASE, language: 'de', urgent: 'no', delivery: 'none' }, tr2);
  const dd = await upload(tr2, de);
  const r2 = await tr2.req('POST', `/api/documents/${dd.id}/certificate`);
  assert.equal(r2.status, 409);
  assert.match(r2.body.message, /документ о знании языка \(«Немецкий»\)/);
  await S.sql`insert into dossier_items (user_id, kind, title, language) values (${tr2.user.id}, 'language', 'Немецкий, не проверен', 'de')`;
  assert.equal((await tr2.req('POST', `/api/documents/${dd.id}/certificate`)).status, 409, 'не проверенный — не в счёт');
  await S.sql`update dossier_items set verified_at = now() where user_id = ${tr2.user.id} and language = 'de'`;
  await S.sql`update users set full_name = '' where id = ${tr2.user.id}`;
  const r3 = await tr2.req('POST', `/api/documents/${dd.id}/certificate`);
  assert.equal(r3.status, 409);
  assert.match(r3.body.message, /фамилию/);
  await S.sql`update users set full_name = 'Тестов Второй' where id = ${tr2.user.id}`;
  const ok = await tr2.req('POST', `/api/documents/${dd.id}/certificate`);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // Номера идут подряд.
  const [{ n }] = await S.sql`select count(*)::int as n from certificates`;
  assert.ok(n >= 2);

  // Файл удалён, пока дело в работе, — сертификат отозван; страница так и скажет; лист больше не выдаётся.
  assert.equal((await tr2.req('DELETE', `/api/documents/${dd.id}`)).status, 204);
  const chk = await client(S).req('GET', `/api/certificates/${ok.body.certificate.code}`);
  assert.equal(chk.body.certificate.state, 'revoked');
  assert.ok(chk.body.certificate.revoked_at);
  assert.equal((await tr2.req('GET', `/api/documents/${dd.id}/certificate`, undefined, { binary: true })).status, 404);
  // Новый файл — новый сертификат с новым номером.
  const dd2 = await upload(tr2, de, Buffer.from('%PDF-1.4 исправленный перевод'));
  const ok2 = await tr2.req('POST', `/api/documents/${dd2.id}/certificate`);
  assert.equal(ok2.status, 201);
  assert.notEqual(ok2.body.certificate.number, ok.body.certificate.number);
});
