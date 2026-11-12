// Извещение об осмотре (задача 2.470, «Ущерб автомобилю после ДТП»): эксперт записывает, кого извещает (страховая, второй
// участник), дату, время и место осмотра, скачивает образец Word и отмечает «извещены, как и когда»; отмеченное — строкой в
// раздел «4. Осмотр» черновика.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { NOTICE_HEAD, noticeLine, placeNotice } from '../../src/orders/notices.mjs';
import { inspectAt } from '../../src/ops/notice-ops.mjs';

let S, owner, dispatcher, spec, other;
const FIELDS = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, vin: 'XTA00000000000001',
  reg_number: 'А001АА777', accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т', damage: 'Задний бампер', method: 'osago',
  insurer: 'Тест-Страх, убыток 123' };

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004701');
  dispatcher = await login(S, '+79990004702');
  spec = await login(S, '+79990004703');
  other = await login(S, '+79990004704');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'car_damage'], ['expertise', 'realty']] });
  await makeSpecialist(S.sql, other.user.id, { permits: [['expertise', 'car_damage']] });
  await spec.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт Иванович' });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
async function inWork(service = 'car_damage', fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'ДТП: извещение' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}
const download = async (c, path) => {
  const r = await fetch(S.base + path, { headers: { cookie: c.cookie } });
  return { status: r.status, disposition: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
};

test('описание модуля: извещение только у ущерба после ДТП, раздел «Осмотр» с пометкой notice; ошибки описания ловятся', () => {
  const reg = createRegistry();
  assert.deepEqual(reg.notice('expertise', 'car_damage').parties.map((p) => p.id), ['insurer', 'other']);
  assert.equal(reg.notice('expertise', 'realty'), null);
  assert.equal(reg.draftSections('expertise', 'car_damage').find((s) => s.notice).title, '4. Осмотр');
  assert.throws(() => validateModule({ ...expertise, notice: { ...expertise.notice, fields: ['nope'] } }), /нет поля nope/);
  assert.throws(() => validateModule({ ...expertise, notice: { ...expertise.notice, services: ['nope'] } }), /нет услуги nope/);
  assert.throws(() => validateModule({ ...expertise, notice: { ...expertise.notice, parties: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] } }), /без повторов/);
});

test('дата и время осмотра: по Москве, не раньше 60 дней назад и не дальше года', () => {
  assert.equal(inspectAt('2026-11-20', '10:30', '2026-11-12').toISOString(), '2026-11-20T07:30:00.000Z');
  assert.throws(() => inspectAt('2026-11-20', '25:00', '2026-11-12'), /время/);
  assert.throws(() => inspectAt('2026-02-30', '10:00', '2026-11-12'), /дату/);
  assert.throws(() => inspectAt('2026-08-01', '10:00', '2026-11-12'), /60 дней/);
  assert.throws(() => inspectAt('2028-01-01', '10:00', '2026-11-12'), /года/);
});

test('строка в черновик: только отмеченные; перенесённый осмотр — своей частью; заменяется целиком', () => {
  const parties = [{ id: 'insurer', name: 'Страховая' }, { id: 'other', name: 'Второй участник ДТП' }];
  const at = new Date('2026-11-20T07:30:00Z');
  const list = [
    { party: 'insurer', name: 'АО «Тест-Страх»', inspect_at: at, place: 'г. Москва, ул. Тестовая, 1.', how: 'telegram', sent_on: '2026-11-12' },
    { party: 'other', name: 'Петров П. П.', inspect_at: at, place: 'г. Москва, ул. Тестовая, 1.', how: null, sent_on: null },
  ];
  assert.equal(noticeLine([list[1]], parties), null);
  const line = noticeLine(list, parties);
  assert.equal(line, `${NOTICE_HEAD} об осмотре 20.11.2026 в 10:30, место — г. Москва, ул. Тестовая, 1, извещены: АО «Тест-Страх» (страховая) — телеграммой 12.11.2026.`);
  const two = noticeLine([list[0], { ...list[1], how: 'letter', sent_on: '2026-11-13', inspect_at: new Date('2026-11-21T07:00:00Z') }], parties);
  assert.match(two, /извещены: АО «Тест-Страх» \(страховая\) — телеграммой 12\.11\.2026\. Также об осмотре 21\.11\.2026 в 10:00, .*Петров П\. П\. \(второй участник ДТП\) — заказным письмом с уведомлением 13\.11\.2026\.$/);
  const sections = [{ title: '3. Объект' }, { title: '4. Осмотр', notice: true }];
  const body = '## 3. Объект\nМашина.\n## 4. Осмотр\nОсмотр проведён.';
  const placed = placeNotice(body, sections, line);
  assert.equal(placed, `## 3. Объект\nМашина.\n## 4. Осмотр\n${line}\nОсмотр проведён.`);
  assert.equal(placeNotice(placed, sections, two).split(NOTICE_HEAD).length, 2, 'прежняя строка заменена, не задвоена');
  assert.equal(placeNotice(body, [{ title: '4. Осмотр' }], line), body, 'нет раздела с notice — не трогаем');
});

test('эксперт дела: записать, Word, отметить; остальные стороны видят и только читают; строка — в черновик от ИИ', async () => {
  const o = await inWork();
  const base = `/api/orders/${o.id}/notices`;
  const v0 = (await spec.req('GET', base)).body;
  assert.equal(v0.available, true);
  assert.equal(v0.can_write, true);
  assert.deepEqual(v0.notices, []);
  assert.equal(v0.line, null);
  const day = addDays(todayMsk(), 3);
  const ins = { party: 'insurer', name: 'АО «Тест-Страх»', date: day, time: '10:30', place: 'г. Москва, ул. Тестовая, 1' };
  assert.equal((await spec.req('POST', base, { ...ins, party: 'judge' })).status, 400, 'кого — только из модуля');
  assert.equal((await spec.req('POST', base, { ...ins, time: '' })).status, 400);
  assert.equal((await spec.req('POST', base, { ...ins, place: '' })).status, 400);
  const v1 = await spec.req('POST', base, ins);
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  const n1 = v1.body.notices[0];
  assert.deepEqual({ ...n1, id: undefined }, { id: undefined, party: 'insurer', party_name: 'Страховая', name: 'АО «Тест-Страх»', date: day, time: '10:30',
    place: 'г. Москва, ул. Тестовая, 1', how: null, how_name: null, sent_on: null, late: false });
  const v2 = (await spec.req('POST', base, { ...ins, party: 'other', name: 'Петров П. П.' })).body;
  const n2 = v2.notices[1];

  // Word: кому, когда и где, автомобиль и ДТП из заявки, эксперт.
  const w = await download(spec, `${base}/${n1.id}/doc`);
  assert.equal(w.status, 200);
  assert.match(decodeURIComponent(w.disposition), /Извещение об осмотре — АО Тест-Страх\.docx/);
  const text = (await extractPages(w.buf, 'x.docx')).pages.join('\n');
  for (const re of [/Кому: АО «Тест-Страх» \(страховая\)/, new RegExp(`${day.split('-').reverse().join('\\.')} в 10:30`), /г\. Москва, ул\. Тестовая, 1/,
    /Тестовая Модель/, /XTA00000000000001/, /А001АА777/, /14\.09\.2026/, /Тестовый пр-т/, /Тестов Эксперт Иванович/, /восстановительного ремонта/]) {
    assert.match(text, re);
  }
  assert.doesNotMatch(text, /Задний бампер/, 'что повреждено — не в извещении (не в notice.fields)');

  // Отметка «извещены».
  const mark = `${base}/${n1.id}/mark`;
  assert.equal((await spec.req('PUT', mark, { how: 'pigeon', sent_on: todayMsk() })).status, 400);
  assert.equal((await spec.req('PUT', mark, { how: 'telegram', sent_on: addDays(todayMsk(), 1) })).status, 400, 'не из будущего');
  const m1 = (await spec.req('PUT', mark, { how: 'telegram', sent_on: todayMsk() })).body;
  assert.equal(m1.notices[0].how_name, 'телеграммой');
  assert.match(m1.line, /^Извещение об осмотре: об осмотре .* извещены: АО «Тест-Страх» \(страховая\) — телеграммой /);
  assert.doesNotMatch(m1.line, /Петров/, 'неотмеченный — не в строке');

  // Остальные стороны видят, но не пишут; чужой эксперт — «не найдено».
  for (const c of [owner, dispatcher]) {
    const v = (await c.req('GET', base)).body;
    assert.equal(v.can_write, false);
    assert.equal(v.notices.length, 2);
    assert.equal((await c.req('POST', base, ins)).status, 403);
    assert.equal((await c.req('PUT', mark, { how: null })).status, 403);
    assert.equal((await c.req('DELETE', `${base}/${n2.id}`)).status, 403);
    assert.equal((await download(c, `${base}/${n1.id}/doc`)).status, 200);
  }
  assert.equal((await other.req('GET', base)).status, 404);
  assert.equal((await spec.req('GET', `${base}/999999/doc`)).status, 404);

  // Черновик от ИИ: строка — сразу под заголовком «4. Осмотр»; модели сказано не ставить пометку.
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const at = d.body.indexOf('## 4. Осмотр');
  assert.ok(at >= 0);
  assert.equal(d.body.slice(at).split('\n')[1], m1.line);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.match(prompt, /программа сама вставит эту строку в раздел об осмотре/);

  // Снять отметку, удалить; после сдачи — только чтение.
  assert.equal((await spec.req('PUT', mark, { how: null })).body.line, null);
  assert.equal((await spec.req('DELETE', `${base}/${n2.id}`)).body.notices.length, 1);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await spec.req('GET', base)).body.can_write, false);
  assert.equal((await spec.req('POST', base, ins)).status, 409);
});

test('не ДТП — блока нет; известили позже осмотра — пометка late', async () => {
  const r = await inWork('realty', { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 47', area: '44' });
  assert.deepEqual((await spec.req('GET', `/api/orders/${r.id}/notices`)).body, { available: false });
  assert.equal((await spec.req('POST', `/api/orders/${r.id}/notices`, {})).status, 409);
  const o = await inWork();
  const past = addDays(todayMsk(), -2);
  const v = (await spec.req('POST', `/api/orders/${o.id}/notices`, { party: 'other', name: 'Петров П. П.', date: past, time: '09:00', place: 'г. Москва' })).body;
  const m = (await spec.req('PUT', `/api/orders/${o.id}/notices/${v.notices[0].id}/mark`, { how: 'phone', sent_on: todayMsk() })).body;
  assert.equal(m.notices[0].late, true);
});
