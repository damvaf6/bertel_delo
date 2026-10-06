// Досье эксперта (2.14): документы эксперта с копиями, напоминания о сроках, подстановка в черновик, копии в приложения,
// сверка отчёта с досье в ИИ-проверке, предупреждение диспетчеру в подборе.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { remindDossier, fillDraft, termState } from '../../src/dossier/dossier.mjs';
import { runAutoChecks } from '../../src/ai/report-checks.mjs';
import { makeDocx } from '../tools/make-docs.mjs';

let S, owner, dispatcher, spec, other;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = Buffer.from('%PDF-1.4 тестовая копия');

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990001401');
  dispatcher = await login(S, '+79990001402');
  spec = await login(S, '+79990001403');
  other = await login(S, '+79990001404');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle'], ['expertise', 'realty']] });
  await makeSpecialist(S.sql, other.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

const file = (c, id, body = PDF, name = 'аттестат.pdf', type = 'application/pdf') => c.req('POST', `/api/specialist/me/dossier/${id}/file`, body, {
  raw: true, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
});

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

async function vehicleOrder(executor = spec) {
  const created = await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Тест досье' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const o = created.body.order;
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая модель' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  return { o, offer: () => dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: executor.user.id, from: 'matching' }) };
}

test('досье: виды документов, обязательные поля, свои записи; чужие — «не найдено»', async () => {
  const empty = await spec.req('GET', '/api/specialist/me/dossier');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);
  assert.ok(empty.body.kinds.some((k) => k.id === 'certificate'));
  assert.equal((await owner.req('GET', '/api/specialist/me/dossier')).status, 404, 'не специалист');

  // Аттестат без срока, полис без суммы, лишнее поле, неверная дата — отказ.
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'certificate', title: 'Оценка движимого имущества', number: '000123-2' })).status, 400);
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'policy', title: 'Тестовое страхование', number: 'П-1', valid_until: addDays(todayMsk(), 100) })).status, 400);
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'sro', title: 'Тестовая СРО', number: '1234', amount_rub: 5 })).status, 400);
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'education', title: 'Тестовый вуз', issued_on: '2020-13-01' })).status, 400);
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'nope', title: 'x' })).status, 400);

  const add = (b) => spec.req('POST', '/api/specialist/me/dossier', b);
  const cert = await add({ kind: 'certificate', title: 'Оценка движимого имущества', number: '000123-2', issued_on: '2024-01-15', valid_until: addDays(todayMsk(), 400) });
  assert.equal(cert.status, 201);
  assert.equal((await add({ kind: 'sro', title: 'Тестовая СРО оценщиков', number: '4567' })).status, 201);
  const pol = await add({ kind: 'policy', title: 'Тестовое страхование', number: 'ТП-77', valid_until: addDays(todayMsk(), 200), amount_rub: 5000000 });
  assert.equal(pol.status, 201);
  const edu = await add({ kind: 'education', title: 'Тестовый университет, оценка собственности', number: 'ДИП-1' });
  assert.equal(edu.status, 201);
  const items = edu.body.items;
  assert.deepEqual(items.map((i) => i.kind), ['education', 'certificate', 'sro', 'policy'], 'по порядку видов');
  assert.equal(items.find((i) => i.kind === 'policy').amount_kop, 500000000);

  // Копия — один раз; новая заменяет прежнюю; скачать может только сам эксперт.
  assert.equal((await file(spec, cert.body.id, Buffer.alloc(0))).status, 400);
  assert.equal((await file(spec, cert.body.id)).status, 200);
  const replaced = await file(spec, cert.body.id, Buffer.from('%PDF-1.4 новая копия'), 'аттестат-2.pdf');
  assert.equal(replaced.body.items.find((i) => i.id === cert.body.id).file.name, 'аттестат-2.pdf');
  assert.equal((await S.sql`select count(*)::int as n from dossier_items where file_key is not null and user_id = ${spec.user.id}`)[0].n, 1);
  assert.equal((await spec.req('GET', `/api/specialist/me/dossier/${cert.body.id}/file`)).status, 200);
  assert.equal((await file(spec, pol.body.id, PDF, 'полис.pdf')).status, 200);

  // Чужое досье: ни прочитать, ни поправить, ни убрать, ни скачать.
  for (const c of [other, owner, dispatcher]) {
    assert.equal((await c.req('PUT', `/api/specialist/me/dossier/${cert.body.id}`, { title: 'Подлог', number: '1', valid_until: addDays(todayMsk(), 10) })).status, 404);
    assert.equal((await c.req('DELETE', `/api/specialist/me/dossier/${cert.body.id}`)).status, 404);
    assert.equal((await c.req('GET', `/api/specialist/me/dossier/${cert.body.id}/file`)).status, 404);
    assert.equal((await file(c, cert.body.id)).status, 404);
  }
  assert.equal((await other.req('GET', '/api/specialist/me/dossier')).body.items.length, 0);

  // Поправить и убрать.
  const upd = await spec.req('PUT', `/api/specialist/me/dossier/${edu.body.id}`, { title: 'Тестовый университет', number: 'ДИП-2' });
  assert.equal(upd.body.items.find((i) => i.id === edu.body.id).number, 'ДИП-2');
  const tmp = await add({ kind: 'education', title: 'Курсы повышения квалификации' });
  assert.equal((await spec.req('DELETE', `/api/specialist/me/dossier/${tmp.body.id}`)).body.items.length, 4);
  assert.equal((await spec.req('DELETE', `/api/specialist/me/dossier/${tmp.body.id}`)).status, 404);
});

test('напоминания: за 30 и 7 дней — эксперту, истёк — эксперту и диспетчеру; по разу; новый срок — снова', async () => {
  const c = await other.req('POST', '/api/specialist/me/dossier', { kind: 'certificate', title: 'Оценка движимого имущества', number: '999-1', valid_until: addDays(todayMsk(), 30) });
  const today = todayMsk();
  const ev = async (u) => (await S.sql`select event from notifications where user_id = ${u} and event like 'dossier%' order by id`).map((r) => r.event);
  await remindDossier(S.sql, { today });
  await remindDossier(S.sql, { today });
  assert.deepEqual(await ev(other.user.id), ['dossier_month'], 'один раз');
  await remindDossier(S.sql, { today: addDays(today, 23) });
  await remindDossier(S.sql, { today: addDays(today, 31) });
  await remindDossier(S.sql, { today: addDays(today, 32) });
  assert.deepEqual(await ev(other.user.id), ['dossier_month', 'dossier_week', 'dossier_expired']);
  assert.deepEqual(await ev(dispatcher.user.id), ['dossier_expired_staff']);
  // СМС — без номера документа и имени.
  const sms = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                          where n.user_id = ${other.user.id} and n.event = 'dossier_week'`;
  assert.ok(sms.length && !/999-1/.test(sms[0].body));
  // Новый срок — напоминания по нему.
  await other.req('PUT', `/api/specialist/me/dossier/${c.body.id}`, { title: 'Оценка движимого имущества', number: '999-2', valid_until: addDays(today, 60) });
  await remindDossier(S.sql, { today: addDays(today, 31) });
  assert.equal((await ev(other.user.id)).at(-1), 'dossier_month');
  assert.equal(termState(addDays(today, -1), today), 'expired');
  assert.equal(termState(addDays(today, 30), today), 'soon');
  assert.equal(termState(addDays(today, 31), today), 'ok');
});

test('подбор (решение Дамира 03.10.2026): истёкший аттестат или полис снимает с подбора по оценке; по другим услугам — только предупреждение', async () => {
  await S.sql`update dossier_items set valid_until = ${addDays(todayMsk(), -1)}::date where user_id = ${other.user.id} and kind = 'certificate'`;
  const { o, offer } = await vehicleOrder(other);
  const cands = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(!cands.some((c) => c.user_id === other.user.id), 'оценка транспорта — эксперта с истёкшим аттестатом в подборе нет');
  assert.deepEqual(cands.find((c) => c.user_id === spec.user.id).dossier_expired, []);
  const r = await offer();
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_eligible');

  // Товароведческая экспертиза — не оценка: эксперт в подборе, с красной строкой.
  await S.sql`insert into specialist_permits (user_id, module, service) values (${other.user.id}, 'expertise', 'goods')`;
  const g = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'goods', title: 'Тест досье — товар' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', subject: 'Тестовый товар с недостатком', questions: 'Есть ли недостаток?' };
  assert.equal((await owner.req('PATCH', `/api/orders/${g.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await step(owner, g, 'matching')).status, 200);
  await ensurePaid(S.sql, g.id);
  const gc = (await dispatcher.req('GET', `/api/orders/${g.id}/candidates`)).body.candidates;
  assert.deepEqual(gc.find((c) => c.user_id === other.user.id).dossier_expired, ['Квалификационный аттестат']);

  // Обновил аттестат — снова в подборе по оценке.
  await S.sql`update dossier_items set valid_until = ${addDays(todayMsk(), 100)}::date where user_id = ${other.user.id} and kind = 'certificate'`;
  assert.ok((await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates.some((c) => c.user_id === other.user.id));
  await S.sql`update dossier_items set valid_until = ${addDays(todayMsk(), -1)}::date where user_id = ${other.user.id} and kind = 'certificate'`;

  const list = (await dispatcher.req('GET', '/api/specialists')).body.specialists;
  const al = list.find((s) => s.user_id === other.user.id).dossier_alerts;
  assert.equal(al[0].state, 'expired');
  assert.ok(!JSON.stringify(list).includes('999-2'), 'номера документов диспетчеру не видны');
  const me = (await other.req('GET', '/api/specialist/me')).body.specialist;
  assert.equal(me.dossier_alerts[0].state, 'expired');
});

test('черновик: сведения из досье — в «Сведения об оценщике», копии — в перечень приложений; заказчику досье не видно', async () => {
  const { o, offer } = await vehicleOrder();
  assert.equal((await offer()).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const d = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: null });
  assert.equal(d.status, 201);
  const body = d.body.draft.body;
  const sect = body.split('\n## ').find((x) => x.startsWith('6. Сведения'));
  assert.ok(sect.includes('Сведения об эксперте (из досье):'), sect);
  assert.ok(sect.includes('Квалификационный аттестат: Оценка движимого имущества, № 000123-2'), sect);
  assert.ok(sect.includes('Членство в СРО: Тестовая СРО оценщиков, номер в реестре 4567'));
  assert.ok(sect.includes('страховая сумма 5 000 000 руб.'), sect);
  const app = body.split('\n## ').find((x) => x.startsWith('14. Литература') && x.includes('из досье'));
  assert.ok(app.includes('Приложение 1. Квалификационный аттестат № 000123-2') && app.includes('Приложение 2. Полис страхования оценщика № ТП-77'), app);
  assert.equal(d.body.draft.inputs.dossier, 4);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('СВЕДЕНИЯ ОБ ЭКСПЕРТЕ'));

  // Копии из досье — в результат; повторно не дублируются; заказчик и посторонний их не прикладывают.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/dossier`)).status, 403);
  assert.equal((await other.req('POST', `/api/orders/${o.id}/dossier`)).status, 404);
  const att = await spec.req('POST', `/api/orders/${o.id}/dossier`);
  assert.equal(att.status, 201);
  assert.deepEqual(att.body.documents.map((x) => x.filename), ['Приложение 1 — Квалификационный аттестат № 000123-2.pdf', 'Приложение 2 — Полис страхования оценщика № ТП-77.pdf']);
  assert.ok(att.body.documents.every((x) => x.kind === 'result'));
  const again = await spec.req('POST', `/api/orders/${o.id}/dossier`);
  assert.equal(again.status, 200);
  assert.equal(again.body.skipped, 2);
  const docs = (await owner.req('GET', `/api/orders/${o.id}/documents`)).body;
  assert.equal(docs.documents.filter((x) => x.kind === 'result').length, 0, 'заказчик видит результат только после проверки');
  assert.ok(!JSON.stringify((await owner.req('GET', `/api/orders/${o.id}`)).body).includes('000123-2'));
});

test('истёкший документ попадает в черновик с пометкой «заполнить» — приложить черновик нельзя, пока не исправлен', () => {
  const today = todayMsk();
  const items = [{ kind: 'certificate', kind_name: 'Квалификационный аттестат', title: 'Оценка недвижимости', number: '1-1', valid_until: addDays(today, -3), file: null }];
  const out = fillDraft('## Вводная часть\nтекст', [{ id: 'intro', title: 'Вводная часть: основание', dossier: 'info' }], items, today);
  assert.match(out, /\[заполнить: срок истёк .* — укажите действующий документ\]/);
  assert.equal(fillDraft('## Вводная часть\nтекст', [{ id: 'intro', title: 'Вводная часть', dossier: 'info' }], [], today), '## Вводная часть\nтекст', 'без досье — без изменений');
});

test('ИИ-проверка сверяет отчёт с досье: срок на дату отчёта, номер, страховая сумма', async () => {
  const today = '2026-10-03';
  const items = [
    { kind: 'certificate', kind_name: 'Квалификационный аттестат', number: '000123-2', valid_until: '2026-09-01' },
    { kind: 'sro', kind_name: 'Членство в СРО', number: '4567', valid_until: null },
    { kind: 'policy', kind_name: 'Полис страхования оценщика', number: 'ТП-77', valid_until: '2027-01-01', amount_kop: 500000000 },
    { kind: 'education', kind_name: 'Диплом об образовании', number: 'ДИП-2', valid_until: null },
  ];
  const report = [{ name: 'Отчёт.docx', pages: [
    'Отчёт № 15\nДата составления отчёта: 20.08.2026\nКвалификационный аттестат № 000123-2 действует до 01.09.2026',
    'Оценщик — член СРО, номер в реестре 4568\nПолис № ТП-77, страховая сумма 3 000 000 руб.',
  ] }];
  const ctx = { dossier: { items, today } };
  const r = runAutoChecks(['dossier_appraiser', 'dossier_education'], report, ctx);
  const t = r.dossier_appraiser.map((f) => f.text);
  assert.ok(!t.some((x) => /аттестат.*истёк/i.test(x)), 'на 20.08.2026 аттестат действовал');
  assert.ok(t.some((x) => /СРО № 4567 из досье в отчёте не найден/.test(x)), t.join('\n'));
  assert.ok(t.some((x) => /Страховая сумма по полису № ТП-77 в досье — 5 000 000 руб\., в отчёте такой суммы нет/.test(x)), t.join('\n'));
  assert.equal(r.dossier_appraiser.find((f) => /полису/.test(f.text)).where, 'стр. 2');
  assert.ok(/Диплом об образовании № ДИП-2 из досье в отчёте не найден/.test(r.dossier_education[0].text));

  // Отчёт составлен после конца срока аттестата.
  const late = [{ name: 'Отчёт.docx', pages: ['Дата составления отчёта: 15.09.2026\nКвалификационный аттестат № 000123-2\nСРО, номер в реестре 4567\nПолис ТП-77 на 5 000 000 руб.'] }];
  const t2 = runAutoChecks(['dossier_appraiser'], late, ctx).dossier_appraiser.map((f) => f.text);
  assert.deepEqual(t2, ['Квалификационный аттестат № 000123-2 действует до 01.09.2026, а отчёт составлен 15.09.2026 — на дату отчёта срок истёк']);
  // Без досье — правило молчит.
  assert.deepEqual(runAutoChecks(['dossier_appraiser'], late, { dossier: { items: [], today } }).dossier_appraiser, []);
});

test('ИИ-проверка дела: находки по досье — под правилом «Сведения по закону об оценке»', async () => {
  const { o, offer } = await vehicleOrder();
  assert.equal((await offer()).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const docx = makeDocx(['Отчёт об оценке', 'Квалификационный аттестат № 000123-2', 'СРО, номер в реестре 4567', 'Полис № ТП-77, страховая сумма 1 000 000 руб.']);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, docx, { raw: true, headers: { 'content-type': DOCX, 'x-file-name': encodeURIComponent('Отчёт.docx') } })).status, 201);
  const r = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(r.status, 201);
  const item = r.body.ai.items.find((i) => i.id === 'appraiser');
  assert.ok(item.found?.some((f) => /в отчёте такой суммы нет/.test(f.text)), JSON.stringify(item));
});

test('руководитель (2.63): напоминания о сроках досье своих экспертов и строка в «Сегодня» — без номеров и копий; чужому — ничего', async () => {
  const today = todayMsk();
  const expert = await login(S, '+79990001405');
  const head = await login(S, '+79990001406');
  const stranger = await login(S, '+79990001407');
  await makeSpecialist(S.sql, expert.user.id, { permits: [['expertise', 'vehicle']] });
  const org = await makeOrg(S.sql, 'ООО «Досье руководителя»');
  const alien = await makeOrg(S.sql, 'ООО «Чужая оценка»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, expert.user.id, 'member');
  await addMember(S.sql, alien.id, stranger.user.id, 'head');
  await expert.req('PATCH', '/api/me', { full_name: 'Эксперт Досьевый' });
  assert.equal((await expert.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const c = await expert.req('POST', '/api/specialist/me/dossier', { kind: 'policy', title: 'Тестовое страхование', number: 'ПОЛ-777',
    valid_until: addDays(today, 20), amount_rub: 300000 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await file(expert, c.body.id, PDF, 'полис.pdf')).status, 200);

  const ev = async (u) => (await S.sql`select event, org_id from notifications where user_id = ${u} and event like 'dossier%' order by id`)
    .map((r) => `${r.event}${r.org_id ? `@${r.org_id === org.id ? 'org' : 'other'}` : ''}`);
  await remindDossier(S.sql, { today });
  await remindDossier(S.sql, { today });
  assert.deepEqual(await ev(head.user.id), ['dossier_month_head@org'], 'один раз и с организацией');
  assert.deepEqual(await ev(expert.user.id), ['dossier_month']);
  await remindDossier(S.sql, { today: addDays(today, 14) });
  await remindDossier(S.sql, { today: addDays(today, 21) });
  assert.deepEqual(await ev(head.user.id), ['dossier_month_head@org', 'dossier_week_head@org', 'dossier_expired_head@org']);
  assert.deepEqual(await ev(stranger.user.id), [], 'руководителю чужой организации — ничего');
  const sms = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                          where n.user_id = ${head.user.id} and n.event like 'dossier%'`;
  assert.ok(sms.length && sms.every((x) => !/ПОЛ-777|Досьевый/.test(x.body)), 'в СМС нет номера и имени');

  // «Сегодня»: вид документа и срок; ни номера, ни файла.
  const t = (await head.req('GET', '/api/today')).body;
  const g = t.orgs.find((x) => x.id === org.id);
  assert.deepEqual(g.dossier, [{ expert: 'Эксперт Досьевый', kind_name: 'Полис страхования оценщика', valid_until: addDays(today, 20), state: 'soon' }]);
  assert.ok(!JSON.stringify(t).includes('ПОЛ-777') && !JSON.stringify(t).includes('полис.pdf'));
  await S.sql`update dossier_items set valid_until = ${addDays(today, -2)}::date where id = ${c.body.id}`;
  assert.equal((await head.req('GET', '/api/today')).body.orgs.find((x) => x.id === org.id).dossier[0].state, 'expired');
  assert.deepEqual((await stranger.req('GET', '/api/today')).body.orgs.find((x) => x.id === alien.id).dossier, []);
  // Эксперт ушёл из организации — руководитель его документов больше не видит.
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${expert.user.id}`;
  assert.deepEqual((await head.req('GET', '/api/today')).body.orgs.find((x) => x.id === org.id).dossier, []);
});
