// Вызов эксперта в суд (задача 2.441): после «готово» заказчик или диспетчер пишет, что эксперта вызывают на заседание, —
// суд, номер дела, дата и время, адрес, файл повестки; дело не переоткрывается, эксперту — уведомление.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { hearingAt } from '../../src/ops/court-ops.mjs';
import { courtMessages, fakeCourtItems } from '../../src/orders/court.mjs';
import expertise from '../../src/modules/expertise.mjs';

let S, owner, dispatcher, spec, other, admin;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 41', area: '44' };

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004411');
  dispatcher = await login(S, '+79990004412');
  spec = await login(S, '+79990004413');
  other = await login(S, '+79990004414');
  admin = await login(S, '+79990004415');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function step(c, o, to, extra = {}) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...extra });
}
const upload = (c, o, path, name) => c.req('POST', `/api/orders/${o.id}/${path}`, Buffer.from(`%PDF ${name}`), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
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
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  return o;
}

const CALL = () => ({ court: 'Тестовый районный суд г. Москвы', case_no: '2-4411/2026', date: addDays(todayMsk(), 7), time: '10:30',
  address: 'г. Москва, тестовая ул., 1, зал 5' });

test('вызов в суд — в описании модуля: у экспертизы есть, у переводов нет; лишние ключи — не стартует', () => {
  const reg = createRegistry();
  assert.equal(reg.court('expertise'), true);
  assert.equal(reg.court('translation'), false);
  const { court, ...none } = structuredClone(expertise);
  assert.ok(court);
  assert.throws(() => createRegistry([{ ...none, court: { x: 1 } }]), /вызов в суд/);
});

test('дата и время заседания: по Москве, не в прошлом и не дальше двух лет', () => {
  assert.equal(hearingAt('2026-11-10', '10:30', '2026-10-29').toISOString(), '2026-11-10T07:30:00.000Z');
  assert.throws(() => hearingAt('2026-10-28', '10:00', '2026-10-29'), /прошла/);
  assert.equal(hearingAt('2026-10-29', '09:00', '2026-10-29').toISOString(), '2026-10-29T06:00:00.000Z', 'сегодня — можно');
  assert.throws(() => hearingAt('2029-01-01', '10:00', '2026-10-29'), /двух лет/);
  assert.throws(() => hearingAt('2026-02-30', '10:00', '2026-01-01'), /дату/);
  assert.throws(() => hearingAt('2026-11-10', '25:00', '2026-10-29'), /время/);
  assert.throws(() => hearingAt('2026-11-10', '', '2026-10-29'), /время/);
});

test('вызов в суд: заказчик пишет после «готово», дело не переоткрывается, эксперту — уведомление; видят стороны дела', async () => {
  const o = await doneOrder('Квартира: вызов в суд');
  const base = `/api/orders/${o.id}/court`;
  const v0 = (await owner.req('GET', base)).body;
  assert.equal(v0.available, true);
  assert.equal(v0.can_add, true);
  assert.deepEqual(v0.calls, []);
  assert.equal((await spec.req('GET', base)).body.can_add, false, 'эксперт сам не пишет');
  assert.equal((await dispatcher.req('GET', base)).body.can_add, true);
  assert.equal((await admin.req('GET', base)).body.can_add, false, 'администратор только смотрит');
  assert.equal((await spec.req('POST', base, CALL())).status, 403);
  assert.equal((await admin.req('POST', base, CALL())).status, 403);
  assert.equal((await other.req('POST', base, CALL())).status, 404);

  // Проверка полей.
  for (const k of ['court', 'case_no', 'address', 'date', 'time']) {
    const r = await owner.req('POST', base, { ...CALL(), [k]: '' });
    assert.equal(r.status, 400, k);
  }
  assert.equal((await owner.req('POST', base, { ...CALL(), date: addDays(todayMsk(), -1) })).status, 400, 'дата прошла');

  // Файл повестки: свой — да, чужой и файл результата — нет.
  const file = await upload(owner, o, 'court/file', 'Повестка.pdf');
  assert.equal(file.status, 201, JSON.stringify(file.body));
  assert.equal((await upload(spec, o, 'court/file', 'Повестка.pdf')).status, 403, 'эксперт файл повестки не грузит');
  const otherOrder = (await other.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Чужое' })).body.order;
  const foreign = await upload(other, otherOrder, 'documents', 'Чужой.pdf');
  assert.equal((await owner.req('POST', base, { ...CALL(), document_id: foreign.body.document.id })).status, 404);
  const [res] = await S.sql`select id from documents where order_id = ${o.id} and kind = 'result'`;
  assert.equal((await owner.req('POST', base, { ...CALL(), document_id: res.id })).status, 404, 'файл результата — не повестка');

  const r = await owner.req('POST', base, { ...CALL(), document_id: file.body.document.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [row] = await S.sql`select status, deadline, remarks_at from orders where id = ${o.id}`;
  assert.equal(row.status, 'done', 'дело не переоткрывается');
  assert.equal(row.remarks_at, null);

  for (const c of [owner, spec, dispatcher, admin]) {
    const v = (await c.req('GET', base)).body;
    assert.equal(v.calls.length, 1);
    const call = v.calls[0];
    assert.equal(call.court, 'Тестовый районный суд г. Москвы');
    assert.equal(call.case_no, '2-4411/2026');
    assert.equal(new Date(call.hearing_at).toISOString(), new Date(`${CALL().date}T10:30:00+03:00`).toISOString());
    assert.match(call.address, /зал 5/);
    assert.equal(call.side, 'customer');
    assert.equal(call.document.filename, 'Повестка.pdf');
    assert.equal(v.next, call.id);
  }
  // Файл повестки виден эксперту в документах дела.
  const docs = (await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.ok(docs.some((d) => d.filename === 'Повестка.pdf'));

  const notes = await S.sql`select user_id from notifications where order_id = ${o.id} and event = 'court_call'`;
  assert.deepEqual(notes.map((n) => n.user_id), [spec.user.id], 'уведомление — эксперту');
  const feed = (await spec.req('GET', '/api/notifications')).body;
  const item = feed.notifications.find((n) => /вызывают в суд/.test(n.title) && n.order_id === o.id);
  assert.ok(item, 'в ленте эксперта');
  assert.equal(item.to, 'court');
  const [audit] = await S.sql`select details from audit_log where action = 'court.add' and subject_id = ${o.id}`;
  assert.equal(audit.details.side, 'customer');
});

test('вызов в суд: диспетчер — и после закрытия дела; заседание отложили — второй вызов, ближайший первым', async () => {
  const o = await doneOrder('Квартира: суд после закрытия');
  assert.equal((await step(dispatcher, o, 'closed')).status, 200);
  const base = `/api/orders/${o.id}/court`;
  assert.equal((await owner.req('GET', base)).body.can_add, true, 'закрытое дело — тоже');
  const file = await upload(dispatcher, o, 'court/file', 'Определение.pdf');
  assert.equal(file.status, 201, 'файл — и у закрытого дела');
  assert.equal((await dispatcher.req('POST', base, { ...CALL(), date: addDays(todayMsk(), 20), document_id: file.body.document.id })).status, 201);
  assert.equal((await owner.req('POST', base, { ...CALL(), date: addDays(todayMsk(), 3), time: '14:00' })).status, 201);
  const v = (await spec.req('GET', base)).body;
  assert.deepEqual(v.calls.map((c) => c.side), ['customer', 'dispatcher'], 'по дате заседания');
  assert.equal(v.next, v.calls[0].id);
  const [row] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal(row.status, 'closed');
  const n = await S.sql`select count(*)::int as n from notifications where order_id = ${o.id} and event = 'court_call' and user_id = ${spec.user.id}`;
  assert.equal(n[0].n, 2);
});

test('вызов в суд: до сдачи — нельзя, у переводов — нет', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Не сдано' })).body.order;
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/court`)).body.can_add, false);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/court`, CALL())).status, 409);
  assert.equal((await upload(owner, o, 'court/file', 'Повестка.pdf')).status, 409);
  const t = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'notary_paper', title: 'Перевод' })).body.order;
  assert.deepEqual((await owner.req('GET', `/api/orders/${t.id}/court`)).body, { available: false });
});

test('2.442: заседание — в «Моих сроках на две недели» эксперта и в файле для календаря (адрес, напоминание накануне)', async () => {
  const o = await doneOrder('Квартира: заседание в сроках');
  const date = addDays(todayMsk(), 3);
  const far = addDays(todayMsk(), 20);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/court`, { ...CALL(), date, time: '14:15', address: 'г. Москва, ул. Судебная, 7, зал 12' })).status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/court`, { ...CALL(), date: far })).status, 201, 'после двух недель');
  const days = (await spec.req('GET', '/api/specialist/me/schedule')).body.schedule.days;
  const items = days.flatMap((d) => d.items.map((i) => ({ ...i, date: d.date }))).filter((i) => i.kind === 'court' && i.order_id === o.id);
  assert.equal(items.length, 1, 'заседание через 20 дней — не в двух неделях');
  const [h] = items;
  assert.deepEqual([h.date, h.time, h.court, h.case_no, h.address, h.title],
    [date, '14:15', CALL().court, CALL().case_no, 'г. Москва, ул. Судебная, 7, зал 12', 'Квартира: заседание в сроках']);
  assert.ok(days.find((d) => d.date === date).court >= 1, 'в дне заседания — счёт заседаний');
  // Чужие заседания не видны: у другого специалиста их нет.
  await makeSpecialist(S.sql, other.user.id);
  const theirs = (await other.req('GET', '/api/specialist/me/schedule')).body.schedule.days.flatMap((d) => d.items);
  assert.ok(!theirs.some((i) => i.kind === 'court'));

  const cal = String((await spec.req('GET', '/api/specialist/me/schedule?format=ics', undefined, { binary: true })).body).replace(/\r\n /g, '');
  const ev = cal.split('BEGIN:VEVENT').find((e) => e.includes(`UID:court-${h.call_id}@`));
  assert.ok(ev, 'событие заседания в календаре');
  const ymd = date.replace(/-/g, '');
  assert.match(ev, new RegExp(`DTSTART:${ymd}T111500Z\\r\\n`), '14:15 по Москве');
  assert.match(ev, new RegExp(`DTEND:${ymd}T131500Z\\r\\n`), 'два часа');
  assert.match(ev, /SUMMARY:Заседание в суде: Тестовый районный суд г\. Москвы\\, дело № 2-4411\/2026\r\n/);
  assert.match(ev, /LOCATION:г\. Москва\\, ул\. Судебная\\, 7\\, зал 12\r\n/);
  assert.match(ev, /TRANSP:OPAQUE/);
  const eve = addDays(date, -1).replace(/-/g, '');
  assert.match(ev, new RegExp(`TRIGGER;VALUE=DATE-TIME:${eve}T150000Z\\r\\n`), 'накануне в 18:00 по Москве');
  assert.match(ev, /TRIGGER:-PT2H\r\n/);
  assert.ok(!cal.includes(`court-${far}`));
});

test('2.443: заседание сегодня или завтра — в «Сегодня» эксперта: что взять с собой, истёкший полис и пустое досье — предупредить', async () => {
  const lonely = await login(S, '+79990004416');
  await makeSpecialist(S.sql, lonely.user.id);
  const o = await doneOrder('Квартира: заседание завтра');
  const today = todayMsk();
  const tomorrow = addDays(today, 1);
  const file = await upload(owner, o, 'court/file', 'Повестка.pdf');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/court`, { ...CALL(), date: tomorrow, time: '23:50', document_id: file.body.document.id })).status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/court`, { ...CALL(), date: addDays(today, 6) })).status, 201, 'через 6 дней — не сегодня');
  await S.sql`delete from dossier_items where user_id = ${spec.user.id}`;
  let r = (await spec.req('GET', '/api/today')).body.expert.court.filter((x) => x.id === o.id);
  assert.equal(r.length, 1, 'только ближайшее — завтра');
  assert.deepEqual([r[0].day, r[0].time, r[0].today, r[0].court, r[0].case_no, r[0].address],
    [tomorrow, '23:50', false, CALL().court, CALL().case_no, CALL().address]);
  assert.equal(r[0].report.filename, 'Отчёт.pdf');
  assert.equal(r[0].summons.filename, 'Повестка.pdf');
  assert.deepEqual(r[0].missing, ['Квалификационный аттестат', 'Полис страхования оценщика'], 'досье пустое');

  const cert = await spec.req('POST', '/api/specialist/me/dossier', { kind: 'certificate', title: 'Оценка недвижимости', number: 'А-4416', valid_until: addDays(today, 200) });
  assert.equal(cert.status, 201);
  // Полис кончается сегодня — к заседанию завтра уже истёк.
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'policy', title: 'Тестовая страховая', number: 'П-1', valid_until: today, amount_rub: 300000 })).status, 201);
  r = (await spec.req('GET', '/api/today')).body.expert.court.find((x) => x.id === o.id);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.dossier.map((d) => [d.kind, d.expired]), [['certificate', false], ['policy', true]]);
  // Чужим — нет.
  if (!(await S.sql`select 1 from specialists where user_id = ${other.user.id}`).length) await makeSpecialist(S.sql, other.user.id);
  assert.ok(!((await other.req('GET', '/api/today')).body.expert.court ?? []).some((x) => x.id === o.id));
  assert.deepEqual((await lonely.req('GET', '/api/today')).body.expert.court, []);
});

test('2.443: заседание — в пятницу и понедельник «завтра», прошедшее три часа назад — нет', async () => {
  const { hearingsSoon } = await import('../../src/ops/court-ops.mjs');
  const o = await doneOrder('Квартира: заседание в понедельник');
  // Пятница 06.11.2026, заседания — в понедельник 09.11 и во вторник 10.11 (дата вставлена напрямую — «сегодня» в прошлом).
  await S.sql`insert into court_calls (order_id, court, case_no, hearing_at, address, created_by, side) values
    (${o.id}, 'Суд', '2-1', '2026-11-09T07:00:00Z', 'Адрес', ${owner.user.id}, 'customer'),
    (${o.id}, 'Суд', '2-2', '2026-11-10T07:00:00Z', 'Адрес', ${owner.user.id}, 'customer'),
    (${o.id}, 'Суд', '2-3', '2026-11-06T06:00:00Z', 'Адрес', ${owner.user.id}, 'customer')`;
  const fri = await hearingsSoon(S.sql, spec.user.id, '2026-11-06', new Date('2026-11-06T10:00:00Z'));
  assert.deepEqual(fri.filter((x) => x.id === o.id).map((x) => x.case_no), ['2-1'], 'в пятницу — понедельник; прошедшее утром — нет');
  const mon = await hearingsSoon(S.sql, spec.user.id, '2026-11-09', new Date('2026-11-09T05:00:00Z'));
  assert.deepEqual(mon.filter((x) => x.id === o.id).map((x) => [x.case_no, x.today]), [['2-1', true], ['2-2', false]]);
});

const SUMMONS = 'ОПРЕДЕЛЕНИЕ\nо вызове эксперта\nСуд определил вызвать эксперта и поставить перед ним вопросы:\n'
  + '1. Почему в расчёте использованы аналоги из другого района?\n2. На каком основании применена скидка на торг 7%?\n'
  + '3. Учтено ли состояние отделки квартиры?\nСудья ____ Тестовый';

test('2.444: вопросы суда — подсказка модели и поддельная модель (вписанное экспертом первым, из файла — после «вопросы:»)', () => {
  const m = courtMessages({ text: '', file: SUMMONS });
  assert.match(m[0].content, /слово в слово/);
  assert.match(m[0].content, /Не отвечай/);
  assert.match(m[1].content, /ФАЙЛ ОПРЕДЕЛЕНИЯ ИЛИ ПОВЕСТКИ:\nОПРЕДЕЛЕНИЕ/);
  const fromFile = JSON.parse(fakeCourtItems(m[1].content)).items;
  assert.deepEqual(fromFile.map((q) => q.slice(0, 12)), ['Почему в рас', 'На каком осн', 'Учтено ли со']);
  const said = JSON.parse(fakeCourtItems(courtMessages({ text: '1. Первый вопрос\n2. Второй вопрос', file: SUMMONS })[1].content)).items;
  assert.deepEqual(said, ['Первый вопрос', 'Второй вопрос']);
});

test('2.444: «Пояснения к отчёту для суда» — ИИ делит вопросы из повестки, эксперт пишет пояснения, Word видят стороны дела', async () => {
  const { extractPages } = await import('../../src/ai/extract.mjs');
  await spec.req('PATCH', '/api/me', { full_name: 'Пояснов Эксперт' });
  const o = await doneOrder('Квартира: пояснения для суда');
  await S.sql`update orders set report_number = 'ОЦ-77/2026' where id = ${o.id}`;
  const base = `/api/orders/${o.id}/court`;
  const file = await owner.req('POST', `${base}/file`, Buffer.from(SUMMONS), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Определение.txt') } });
  assert.equal(file.status, 201);
  const call = (await owner.req('POST', base, { ...CALL(), document_id: file.body.document.id })).body.id;
  const noFile = (await owner.req('POST', base, { ...CALL(), date: addDays(todayMsk(), 9) })).body.id;
  const q = `${base}/${call}/questions`;
  const word = async (c, id = call) => {
    const r = await fetch(`${S.base}${base}/${id}/explain`, { headers: { cookie: c.cookie } });
    if (r.status !== 200) return { status: r.status, body: await r.json() };
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: 200, name: decodeURIComponent(r.headers.get('content-disposition').split("''")[1]),
      text: (await extractPages(buf, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n') };
  };

  // Ведёт эксперт; заказчик, диспетчер и администратор только смотрят.
  assert.equal((await spec.req('GET', base)).body.can_answer, true);
  for (const c of [owner, dispatcher, admin]) {
    assert.equal((await c.req('GET', base)).body.can_answer, false);
    const v = (await c.req('GET', q)).body;
    assert.equal(v.can_write, false);
    assert.deepEqual(v.items, []);
    assert.equal((await c.req('POST', `${q}/parse`, {})).status, 403);
    assert.equal((await c.req('PUT', q, { items: [{ text: 'x' }] })).status, 403);
  }
  assert.equal((await other.req('GET', q)).status, 404, 'чужой');
  assert.equal((await spec.req('GET', `${base}/999999999/questions`)).status, 404, 'нет такого вызова');
  assert.equal((await spec.req('GET', `${base}/abc/questions`)).status, 404);
  assert.equal((await word(spec)).body.error, 'no_items');

  // Без файла и текста — разбирать нечего; с текстом — вопросы из текста.
  assert.equal((await spec.req('POST', `${base}/${noFile}/questions/parse`, {})).body.error, 'nothing_to_parse');
  const typed = await spec.req('POST', `${base}/${noFile}/questions/parse`, { text: '1. Как определена дата оценки?\n2. Почему не применён затратный подход?' });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.equal(typed.body.items.length, 2);

  const p = await spec.req('POST', `${q}/parse`, {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.items.length, 3);
  assert.ok(p.body.items.every((i) => i.by_ai && !i.answer));
  assert.equal(p.body.left, 3);
  assert.equal(p.body.ready, false);
  assert.match(p.body.items[1].text, /скидка на торг 7%/);
  assert.equal((await spec.req('POST', `${q}/parse`, {})).body.error, 'items_exist', 'без подтверждения не заменяет');
  const [use] = await S.sql`select count(*)::int as n from ai_usage where user_id = ${spec.user.id} and purpose = 'court'`;
  assert.equal(use.n, 2);
  const counted = (await owner.req('GET', base)).body.calls.find((c) => c.id === call);
  assert.deepEqual([counted.questions, counted.unanswered], [3, 3]);
  assert.equal((await word(owner)).body.error, 'items_unanswered', 'без пояснений — Word не собрать');

  // Проверка ввода.
  assert.equal((await spec.req('PUT', q, { items: [{ text: '' }] })).status, 400);
  assert.equal((await spec.req('PUT', q, { items: [{ text: 'a', answer: 'x'.repeat(3001) }] })).status, 400);
  assert.equal((await spec.req('PUT', q, { items: [{ text: 'a', place: 'x'.repeat(201) }] })).status, 400);
  assert.equal((await spec.req('PUT', q, {})).status, 400);

  const items = p.body.items.map((i) => ({ ...i }));
  items[0].answer = 'Аналогов в том же районе на дату оценки не было; взяты соседние районы с поправкой';
  items[0].place = 'раздел 8.2, стр. 31';
  items[1].answer = 'Скидка — по справочнику Лейфера, 2026, для квартир Москвы';
  items.push({ text: 'Вопрос представителя ответчика: почему не учтён ремонт подъезда?', answer: 'Состояние подъезда учтено в описании дома' });
  items.splice(2, 1);
  const s1 = await spec.req('PUT', q, { items: items.map((i) => ({ ...i, answer: i.answer === '' ? '' : i.answer })) });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal(s1.body.items.length, 3);
  assert.equal(s1.body.left, 0);
  assert.equal(s1.body.ready, true);
  assert.equal(s1.body.items[2].by_ai, false);

  for (const c of [spec, owner, dispatcher, admin]) {
    const w = await word(c);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.name, 'Пояснения для суда 2-4411-2026.docx');
    for (const t of ['Пояснения эксперта к отчёту № ОЦ-77/2026', 'Тестовый районный суд г. Москвы', 'по делу № 2-4411/2026',
      'Почему в расчёте использованы аналоги', 'взяты соседние районы', 'раздел 8.2, стр. 31', 'ремонт подъезда', 'Пояснов Эксперт']) {
      assert.ok(w.text.includes(t), `${t}\n${w.text}`);
    }
  }
  assert.equal((await word(other)).status, 404);
  // Чужой вызов в адресе своего дела — не найдено.
  const o2 = await doneOrder('Квартира: другой вызов');
  const call2 = (await owner.req('POST', `/api/orders/${o2.id}/court`, CALL())).body.id;
  assert.equal((await spec.req('GET', `${base}/${call2}/questions`)).status, 404);
  assert.equal((await spec.req('PUT', `${base}/${call2}/questions`, { items: [] })).status, 404);
  assert.equal((await spec.req('GET', `/api/orders/${o2.id}/court/${call2}/questions`)).body.items.length, 0);

  // Закрытое дело — эксперт по-прежнему пишет пояснения.
  assert.equal((await step(dispatcher, o, 'closed')).status, 200);
  assert.equal((await spec.req('GET', q)).body.can_write, true);
  assert.equal((await spec.req('PUT', q, { items: s1.body.items.slice(0, 2) })).status, 200);
  const [a] = await S.sql`select count(*)::int as n from audit_log where subject_id = ${o.id} and action like 'court.questions%'`;
  assert.ok(a.n >= 4);
});
