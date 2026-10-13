// Карточка допуска исполнителя (задача штаба 3f817197-…-81b2): выдаёт, продлевает и отзывает с причиной администратор;
// номер, срок, уровни проверки, QR и открытая страница проверки; отозванная карточка снимает с подбора.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { unzip } from '../../src/docs/docx.mjs';

let S, admin, dispatcher, owner, sp, sp2, stranger;
const until = addDays(todayMsk(), 365);
const FILE = Buffer.from('%PDF-1.4 тестовый перевод');
const BASE = { recipient: 'business', language: 'en', direction: 'to_ru', doc_kind: 'contract', docs: 1, pages: 2, urgent: 'no', delivery: 'none' };

before(async () => {
  S = await startApp();
  admin = await login(S, '+79990000980');
  dispatcher = await login(S, '+79990000981');
  owner = await login(S, '+79990000982');
  sp = await login(S, '+79990000983');
  sp2 = await login(S, '+79990000984');
  stranger = await login(S, '+79990000985');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, sp.user.id, { permits: [['translation', 'plain']], capacity: 20, taxStatus: 'self_employed', languages: ['en'] });
  await makeSpecialist(S.sql, sp2.user.id, { permits: [] });
});
after(async () => { await S?.close(); });

const cardUrl = (who) => `/api/admin/specialists/${who.user.id}/card`;

test('выдать карточку: нужны ФИО и действующий допуск; срок — с завтра до пяти лет; вторая действующая — нельзя', async () => {
  let r = await admin.req('POST', cardUrl(sp), { valid_until: until });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'no_name');
  await S.sql`update users set full_name = 'Тестова Допущенная Ивановна' where id = ${sp.user.id}`;
  await S.sql`update users set full_name = 'Тестов Без Допусков' where id = ${sp2.user.id}`;
  r = await admin.req('POST', cardUrl(sp2), { valid_until: until });
  assert.equal(r.body.error, 'no_permits');
  for (const bad of [todayMsk(), addDays(todayMsk(), -3), addDays(todayMsk(), 6 * 365), '2026-13-01', '']) {
    assert.equal((await admin.req('POST', cardUrl(sp), { valid_until: bad })).status, 400, bad);
  }
  r = await admin.req('POST', cardUrl(sp), { valid_until: until, docs_checked: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.card;
  assert.match(c.number, /^Д-\d{4}-\d{6}$/);
  assert.match(c.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(c.url.endsWith(`/dopusk.html#${c.code.replaceAll('-', '')}`));
  assert.ok(c.qr.startsWith('data:image/png;base64,'));
  assert.equal(c.state, 'valid');
  assert.equal(c.valid_until, until);
  assert.deepEqual(c.services, ['Переводы: ' + c.services[0].split(': ')[1]]);
  // Телефон, статус (самозанятый), документы сверены; КЭП — нет.
  assert.deepEqual(c.checks.map((x) => x.ok), [true, true, true, false]);
  assert.ok(c.checks[1].name.includes('Самозанятый'));
  assert.equal(c.level, 3);
  assert.equal((await admin.req('POST', cardUrl(sp), { valid_until: until })).body.error, 'card_exists');
  const n = await S.sql`select count(*)::int as n from notifications where user_id = ${sp.user.id} and event = 'permit_card_issued'`;
  assert.equal(n[0].n, 1);
});

test('открытая страница проверки: без входа, только номер, ФИО, срок, услуги, проверки; плохой код — 404', async () => {
  const { card } = (await admin.req('GET', cardUrl(sp))).body;
  const anon = await fetch(`${S.base}/api/permit-cards/${card.code.toLowerCase()}`);
  assert.equal(anon.status, 200);
  const pub = (await anon.json()).card;
  assert.deepEqual(Object.keys(pub).sort(), ['checks', 'full_name', 'issued_at', 'level', 'number', 'of', 'services', 'state', 'valid_until']);
  assert.equal(pub.full_name, 'Тестова Допущенная Ивановна');
  assert.ok(!JSON.stringify(pub).includes('79990000983'));
  assert.equal((await fetch(`${S.base}/api/permit-cards/AAAAAAAAAAAA`)).status, 404);
  assert.equal((await fetch(`${S.base}/api/permit-cards/xyz`)).status, 404);
});

test('своя карточка и лист Word с QR; чужие карточки и управление — только администратору', async () => {
  const mine = await sp.req('GET', '/api/specialist/me/card');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.card.state, 'valid');
  assert.equal(mine.body.card.revoke_note, undefined);
  const sheet = await sp.req('GET', '/api/specialist/me/card/sheet', undefined, { binary: true });
  assert.equal(sheet.status, 200);
  const files = unzip(sheet.body);
  const xml = files.find((f) => f.name === 'word/document.xml').data.toString('utf8');
  assert.ok(xml.includes(mine.body.card.number) && xml.includes('Тестова Допущенная Ивановна') && xml.includes(mine.body.card.code));
  assert.ok(files.some((f) => f.name.startsWith('word/media/')), 'QR-картинка');
  assert.equal((await sp2.req('GET', '/api/specialist/me/card')).body.card, null);
  assert.equal((await sp2.req('GET', '/api/specialist/me/card/sheet')).status, 404);
  assert.equal((await stranger.req('GET', '/api/specialist/me/card')).status, 404);
  for (const c of [sp, sp2, dispatcher, owner, stranger]) {
    assert.equal((await c.req('GET', cardUrl(sp))).status, 404);
    assert.equal((await c.req('POST', cardUrl(sp2), { valid_until: until })).status, 404);
    assert.equal((await c.req('PUT', cardUrl(sp), { valid_until: until })).status, 404);
    assert.equal((await c.req('POST', `${cardUrl(sp)}/revoke`, { reason: 'request' })).status, 404);
  }
});

async function matchingOrder(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'plain', title })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 7), fields: BASE });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const m = await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  await ensurePaid(S.sql, o.id);
  return o;
}

test('продлить срок; КЭП проверена на Госуслугах — уровень растёт', async () => {
  const later = addDays(todayMsk(), 700);
  let r = await admin.req('PUT', cardUrl(sp), { valid_until: later });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.card.valid_until, later);
  assert.equal((await admin.req('PUT', cardUrl(sp), {})).status, 400);
  assert.equal((await admin.req('PUT', cardUrl(sp2), { valid_until: later })).status, 404);
  // Подпись исполнителя, отмеченная сотрудником «верна» после проверки на Госуслугах.
  const o = await matchingOrder('Перевод');
  const off = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: sp.user.id, from: 'matching' });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  await sp.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' });
  const doc = (await sp.req('POST', `/api/orders/${o.id}/results`, FILE, { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('p.pdf') } })).body.document;
  assert.equal((await sp.req('POST', `/api/documents/${doc.id}/sign`, { confirm: true })).status, 201);
  r = await admin.req('GET', cardUrl(sp));
  assert.equal(r.body.card.level, 3, 'тестовая подпись поставщика — не в счёт');
  await S.sql`update document_signatures set manual_check = 'ok', manual_checked_by = ${admin.user.id}, manual_checked_at = now() where document_id = ${doc.id}`;
  r = await admin.req('GET', cardUrl(sp));
  assert.equal(r.body.card.level, 4);
  assert.ok(r.body.card.checks[3].ok);
});

test('отзыв с причиной: страница — «отозвана» и общая причина; пояснение — только платформе; снимает с подбора; новая карточка возвращает', async () => {
  const o = await matchingOrder('Перевод 2');
  const cands = async () => (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates.map((c) => c.user_id);
  assert.ok((await cands()).includes(sp.user.id));
  const { card } = (await admin.req('GET', cardUrl(sp))).body;
  assert.equal((await admin.req('POST', `${cardUrl(sp)}/revoke`, {})).status, 400);
  assert.equal((await admin.req('POST', `${cardUrl(sp)}/revoke`, { reason: 'other' })).status, 400, 'другое — с пояснением');
  let r = await admin.req('POST', `${cardUrl(sp)}/revoke`, { reason: 'rules', note: 'Тестовое пояснение: жалоба заказчика' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.card.state, 'revoked');
  assert.equal(r.body.card.revoke_note, 'Тестовое пояснение: жалоба заказчика');
  assert.equal(r.body.history[0].revoke_reason_name, 'Нарушение правил платформы');
  const pub = (await (await fetch(`${S.base}/api/permit-cards/${card.code}`)).json()).card;
  assert.equal(pub.state, 'revoked');
  assert.equal(pub.revoke_reason, 'по решению платформы');
  assert.deepEqual(pub.services, []);
  assert.ok(!JSON.stringify(pub).includes('жалоба'));
  const mine = (await sp.req('GET', '/api/specialist/me/card')).body.card;
  assert.equal(mine.state, 'revoked');
  assert.equal(mine.revoke_reason_name, 'Нарушение правил платформы');
  assert.equal(mine.revoke_note, undefined);
  assert.equal((await sp.req('GET', '/api/specialist/me/card/sheet')).status, 404);
  assert.equal((await S.sql`select count(*)::int as n from notifications where user_id = ${sp.user.id} and event = 'permit_card_revoked'`)[0].n, 1);
  assert.ok(!(await cands()).includes(sp.user.id), 'отозванная карточка — не в подборе');
  assert.equal((await admin.req('POST', `${cardUrl(sp)}/revoke`, { reason: 'request' })).status, 404);
  r = await admin.req('POST', cardUrl(sp), { valid_until: until });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.card.number, card.number);
  assert.equal(r.body.card.docs_checked, false);
  assert.ok((await cands()).includes(sp.user.id));
  // Старая ссылка по-прежнему показывает «отозвана».
  assert.equal((await (await fetch(`${S.base}/api/permit-cards/${card.code}`)).json()).card.state, 'revoked');
});

test('срок истёк — страница показывает «срок истёк»', async () => {
  await S.sql`update permit_cards set valid_until = ${addDays(todayMsk(), -1)} where user_id = ${sp.user.id} and revoked_at is null`;
  const mine = (await sp.req('GET', '/api/specialist/me/card')).body.card;
  assert.equal(mine.state, 'expired');
  assert.equal((await sp.req('GET', '/api/specialist/me/card/sheet')).status, 409);
  const code = mine.code.replaceAll('-', '');
  assert.equal((await (await fetch(`${S.base}/api/permit-cards/${code}`)).json()).card.state, 'expired');
});
