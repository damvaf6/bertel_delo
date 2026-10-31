// Аккредитация в банке (2.451): у эксперта — в досье (банк из списка или свой, решение, срок, копия), у организации —
// вносит руководитель, видят сотрудники. В черновик, копии к делу и сверку отчёта аккредитация не идёт.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { startApp, login, setPlatformRole, makeSpecialist, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { loadDossier, remindDossier } from '../../src/dossier/dossier.mjs';

let S, exp, head, member, headB, dispatcher, stranger, org, orgB;
const PDF = Buffer.from('%PDF-1.4 тестовая копия решения банка');
const upload = (c, url) => c.req('POST', url, PDF, { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('решение.pdf') } });

before(async () => {
  S = await startApp();
  exp = await login(S, '+79990004511');
  head = await login(S, '+79990004512');
  member = await login(S, '+79990004513');
  headB = await login(S, '+79990004514');
  dispatcher = await login(S, '+79990004515');
  stranger = await login(S, '+79990004516');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, exp.user.id);
  org = await makeOrg(S.sql, 'Тестовая оценочная организация 2.451');
  orgB = await makeOrg(S.sql, 'Тестовая чужая организация 2.451');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, member.user.id, 'member');
  await addMember(S.sql, orgB.id, headB.user.id, 'head');
});
after(async () => { await S?.close(); });

test('досье: аккредитация в банке — банк из списка или свой, решение и срок; в черновик и сверку не идёт', async () => {
  const D = '/api/specialist/me/dossier';
  const view = (await exp.req('GET', D)).body;
  assert.deepEqual(view.banks.map((b) => b.id), ['sber', 'other']);
  const kind = view.kinds.find((k) => k.id === 'bank');
  assert.equal(kind.name, 'Аккредитация в банке');
  assert.equal(kind.issued, 'Дата решения банка');
  // Банк из списка — название из списка, даже если написано другое.
  const sber = await exp.req('POST', D, { kind: 'bank', bank: 'sber', title: 'что угодно', number: 'А-17', issued_on: addDays(todayMsk(), -100), valid_until: addDays(todayMsk(), 200) });
  assert.equal(sber.status, 201, JSON.stringify(sber.body));
  const it = sber.body.items.find((i) => i.id === sber.body.id);
  assert.equal(it.title, 'Сбербанк');
  assert.equal(it.bank, 'sber');
  assert.equal(it.state, 'ok');
  // Свой банк — без названия нельзя; неизвестный банк и банк у другого вида документа — нельзя.
  assert.equal((await exp.req('POST', D, { kind: 'bank', bank: 'other' })).status, 400);
  assert.equal((await exp.req('POST', D, { kind: 'bank', bank: 'vtb_x', title: 'Банк' })).status, 400);
  assert.equal((await exp.req('POST', D, { kind: 'bank', title: 'Банк' })).status, 400);
  assert.equal((await exp.req('POST', D, { kind: 'sro', title: 'СРО', number: '1', bank: 'sber' })).status, 400);
  const own = await exp.req('POST', D, { kind: 'bank', bank: 'other', title: 'Тестовый банк «Пример»', valid_until: addDays(todayMsk(), 10) });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.items.find((i) => i.id === own.body.id).state, 'soon');
  // Продлили — новый срок; поменяли банк на свой — название обязательно.
  const put = await exp.req('PUT', `${D}/${own.body.id}`, { bank: 'other', title: 'Тестовый банк «Пример»', valid_until: addDays(todayMsk(), 400) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.items.find((i) => i.id === own.body.id).state, 'ok');
  assert.equal((await exp.req('PUT', `${D}/${sber.body.id}`, { bank: 'other' })).status, 400);
  assert.equal((await upload(exp, `${D}/${sber.body.id}/file`)).status, 200);
  // Черновик, копии к делу, сверка отчёта — без аккредитаций; досье эксперта — с ними.
  assert.ok(!(await loadDossier(S.sql, exp.user.id)).some((i) => i.kind === 'bank'));
  assert.equal((await loadDossier(S.sql, exp.user.id, { banks: true })).filter((i) => i.kind === 'bank').length, 2);
});

test('истёкшая аккредитация в банке: напоминание эксперту, диспетчеру — нет (с подбора не снимает)', async () => {
  const sp = await login(S, '+79990004517');
  await makeSpecialist(S.sql, sp.user.id);
  await sp.req('POST', '/api/specialist/me/dossier', { kind: 'bank', bank: 'sber', valid_until: addDays(todayMsk(), 5) });
  const before = (await S.sql`select count(*)::int as n from notifications where user_id = ${dispatcher.user.id}`)[0].n;
  await remindDossier(S.sql, { today: addDays(todayMsk(), 6) });
  const ev = (await S.sql`select event from notifications where user_id = ${sp.user.id} and (event like 'dossier%' or event like 'bank_accr%')`).map((r) => r.event);
  assert.deepEqual(ev, ['bank_accr_expired'], 'своими словами — аккредитация, не «документ досье» (2.454)');
  assert.equal((await S.sql`select count(*)::int as n from notifications where user_id = ${dispatcher.user.id}`)[0].n, before);
});

test('организация: аккредитации вносит руководитель, видят сотрудники; чужие и служебные — «не найдено»', async () => {
  const A = `/api/orgs/${org.id}/accreditations`;
  const add = await head.req('POST', A, { bank: 'sber', number: 'Р-2026/5', issued_on: addDays(todayMsk(), -30), valid_until: addDays(todayMsk(), 335) });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.manage, true);
  const id = add.body.id;
  assert.equal(add.body.items[0].title, 'Сбербанк');
  assert.equal((await head.req('POST', A, { bank: 'other' })).status, 400);
  assert.equal((await head.req('POST', A, { bank: 'other', title: 'Тестовый банк', valid_until: addDays(todayMsk(), -1), issued_on: addDays(todayMsk(), -2) })).status, 201);
  assert.equal((await upload(head, `${A}/${id}/file`)).status, 200);
  // Сотрудник видит и скачивает, но не меняет.
  const seen = await member.req('GET', A);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.manage, false);
  assert.deepEqual(seen.body.items.map((i) => [i.title, i.state]), [['Сбербанк', 'ok'], ['Тестовый банк', 'expired']]);
  assert.equal((await member.req('GET', `${A}/${id}/file`)).status, 200);
  assert.equal((await member.req('POST', A, { bank: 'sber' })).status, 403);
  assert.equal((await member.req('PUT', `${A}/${id}`, { bank: 'sber' })).status, 403);
  assert.equal((await member.req('DELETE', `${A}/${id}`)).status, 403);
  assert.equal((await upload(member, `${A}/${id}/file`)).status, 403);
  // Чужой руководитель, диспетчер, посторонний — «не найдено»; запись чужой организации по своему адресу — тоже.
  for (const c of [headB, dispatcher, stranger]) {
    assert.equal((await c.req('GET', A)).status, 404);
    assert.equal((await c.req('GET', `${A}/${id}/file`)).status, 404);
    assert.equal((await c.req('PUT', `${A}/${id}`, { bank: 'sber' })).status, 404);
  }
  const B = `/api/orgs/${orgB.id}/accreditations`;
  assert.equal((await headB.req('PUT', `${B}/${id}`, { bank: 'sber' })).status, 404);
  assert.equal((await headB.req('DELETE', `${B}/${id}`)).status, 404);
  assert.equal((await headB.req('GET', `${B}/${id}/file`)).status, 404);
  assert.deepEqual((await headB.req('GET', B)).body.items, []);
  // Продлили, убрали.
  const put = await head.req('PUT', `${A}/${id}`, { bank: 'sber', number: 'Р-2027/1', valid_until: addDays(todayMsk(), 700) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.items.find((i) => i.id === id).number, 'Р-2027/1');
  assert.equal(put.body.items.find((i) => i.id === id).file.name, 'решение.pdf');
  const del = await head.req('DELETE', `${A}/${id}`);
  assert.equal(del.status, 200);
  assert.ok(!del.body.items.some((i) => i.id === id));
  assert.equal((await head.req('GET', `${A}/${id}/file`)).status, 404);
});

test('2.455: руководителю — организация и эксперты по банкам, у кого нет; сотруднику — нет; только банк и срок', async () => {
  const o = await makeOrg(S.sql, 'Тестовая организация 2.455');
  const h = await login(S, '+79990004551');
  const e1 = await login(S, '+79990004552');
  const e2 = await login(S, '+79990004553');
  await addMember(S.sql, o.id, h.user.id, 'head');
  for (const [c, name] of [[e1, 'Тестова Анна'], [e2, 'Тестов Борис']]) {
    await addMember(S.sql, o.id, c.user.id, 'member');
    await S.sql`update users set full_name = ${name} where id = ${c.user.id}`;
    await S.sql`insert into specialists (user_id, org_id) values (${c.user.id}, ${o.id})`;
  }
  const A = `/api/orgs/${o.id}/accreditations`;
  assert.equal((await h.req('GET', A)).body.table.banks.length, 0);
  await h.req('POST', A, { bank: 'sber', number: 'Р-1', valid_until: addDays(todayMsk(), 200) });
  await h.req('POST', A, { bank: 'other', title: 'Тестовый банк «Залог»', valid_until: addDays(todayMsk(), -3) });
  // У Анны Сбербанк кончается, рядом прежняя истёкшая запись (продлила — берётся дольшая); у Бориса — свой банк без срока.
  const D = '/api/specialist/me/dossier';
  await e1.req('POST', D, { kind: 'bank', bank: 'sber', number: 'АК-1', valid_until: addDays(todayMsk(), -40) });
  await e1.req('POST', D, { kind: 'bank', bank: 'sber', number: 'АК-2', valid_until: addDays(todayMsk(), 20) });
  await e2.req('POST', D, { kind: 'bank', bank: 'other', title: 'Тестовый банк «Залог» ', number: 'Б-1' });
  await e2.req('POST', D, { kind: 'bank', bank: 'other', title: 'Тестовый банк «Север»', valid_until: addDays(todayMsk(), 90) });
  const t = (await h.req('GET', A)).body.table;
  assert.equal(t.experts, 2);
  assert.deepEqual(t.banks.map((b) => b.title), ['Сбербанк', 'Тестовый банк «Залог»', 'Тестовый банк «Север»'], 'сначала банки из списка');
  const [sber, zalog, sever] = t.banks;
  assert.deepEqual(sber.org, { valid_until: addDays(todayMsk(), 200), state: 'ok' });
  assert.deepEqual(sber.experts, [{ expert: 'Тестова Анна', valid_until: addDays(todayMsk(), 20), state: 'soon' }]);
  assert.deepEqual(sber.without, ['Тестов Борис']);
  assert.equal(zalog.org.state, 'expired');
  assert.deepEqual(zalog.experts, [{ expert: 'Тестов Борис', valid_until: null, state: null }], 'свой банк — по названию');
  assert.equal(sever.org, null);
  assert.deepEqual(sever.without, ['Тестова Анна']);
  // Без номеров решений и копий экспертов.
  assert.ok(!JSON.stringify(t).includes('АК-'));
  assert.ok(!JSON.stringify(t).includes('Б-1'));
  // Сотрудник таблицы не получает; чужой эксперт с той же записью в досье в таблицу не попадает.
  assert.equal((await e1.req('GET', A)).body.table, undefined);
  await exp.req('POST', D, { kind: 'bank', bank: 'other', title: 'Тестовый банк «Север»' });
  assert.equal((await h.req('GET', A)).body.table.experts, 2);
  assert.ok(!(await h.req('GET', A)).body.table.banks.flatMap((b) => b.experts).some((x) => x.expert !== 'Тестова Анна' && x.expert !== 'Тестов Борис'));
});

// Распаковка ZIP — для проверки архива продления.
function unzipStore(buf) {
  const out = new Map();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const body = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    out.set(buf.subarray(p + 30, p + 30 + nlen).toString('utf8'), buf.readUInt16LE(p + 8) === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 30 + nlen + xlen + csize;
  }
  return out;
}

test('2.456: документы для продления аккредитации — досье с копиями, отметки «срок истёк» и «копии нет», перечень за 12 месяцев', async () => {
  const D = '/api/specialist/me/dossier';
  const e = await login(S, '+79990004561');
  await makeSpecialist(S.sql, e.user.id);
  const add = async (b) => { const r = await e.req('POST', D, b); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id; };
  const cert = await add({ kind: 'certificate', title: 'Оценка недвижимости', number: '031234-1', issued_on: addDays(todayMsk(), -1200), valid_until: addDays(todayMsk(), -3) });
  const sro = await add({ kind: 'sro', title: 'Тестовая СРО оценщиков', number: '4321' });
  await add({ kind: 'policy', title: 'Тестовое страхование', number: 'П-1', valid_until: addDays(todayMsk(), 100), amount_rub: 300000 });
  const bank = await add({ kind: 'bank', bank: 'sber', number: 'А-99', issued_on: addDays(todayMsk(), -340), valid_until: addDays(todayMsk(), 20) });
  await add({ kind: 'bank', bank: 'other', title: 'Тестовый банк «Другой»' });
  for (const id of [cert, sro, bank]) assert.equal((await upload(e, `${D}/${id}/file`)).status, 200);
  const r = await e.req('GET', `${D}/${bank}/renewal`, undefined, { binary: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /Продление аккредитации · Сбербанк\.zip/);
  const files = unzipStore(r.body);
  const names = [...files.keys()];
  assert.deepEqual(names.filter((n) => n.startsWith('Копии документов/')).sort(), [
    'Копии документов/01 Квалификационный аттестат.pdf', 'Копии документов/02 Членство в СРО.pdf', 'Копии документов/03 Решение банка Сбербанк.pdf']);
  assert.ok(files.get('Копии документов/02 Членство в СРО.pdf').equals(PDF));
  assert.ok(!names.some((n) => n.includes('Другой')), 'другая аккредитация — не в архиве');
  const csv = files.get('Перечень отчётов за 12 месяцев.csv').toString('utf8');
  assert.match(csv, /Период: 12 месяцев: с \d\d\.\d\d\.\d{4} по \d\d\.\d\d\.\d{4}/);
  assert.ok(!csv.includes('Заказчик'), 'без заказчиков');
  const doc = names.find((n) => n.endsWith('.docx'));
  assert.equal(doc, 'Продление аккредитации · Сбербанк.docx');
  const text = unzipStore(files.get(doc)).get('word/document.xml').toString('utf8').replace(/<[^>]+>/g, ' ');
  for (const s of ['решение № А-99', 'Квалификационный аттестат', '031234-1', 'срок истёк', 'Тестовая СРО оценщиков', 'в реестре 4321',
    'Полис страхования оценщика', 'копии в досье нет', 'Копии не загружены: Полис страхования оценщика', 'сданных отчётов об оценке', 'сумма 300 000 руб.']) {
    assert.ok(text.includes(s), s);
  }
  assert.equal((await S.sql`select count(*)::int as n from audit_log where action = 'dossier.renewal' and subject_id = ${e.user.id}`)[0].n, 1);
});
