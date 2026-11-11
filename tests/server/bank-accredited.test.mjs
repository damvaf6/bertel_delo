// 2.458: ИИ-проверка отчёта для банка — эксперт или его организация аккредитованы в банке-пользователе на дату отчёта.
// Своя аккредитация — из досье, организации — у той, от которой эксперт работает и где состоит. Нет — находка.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, makeOrg, addMember, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { runAutoChecks } from '../../src/ai/report-checks.mjs';

const doc = (pages, name = 'Отчёт.docx') => ({ name, pages });
const report = (made, user = 'ПАО Сбербанк') => doc([`ОТЧЁТ ОБ ОЦЕНКЕ № 7\nДата составления отчёта: ${made}\nЦель оценки: для залога\nПредполагаемый пользователь результатов оценки: ${user}`]);
const task = (user) => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nЦель оценки: для ипотечного кредитования\nПредполагаемые пользователи результатов оценки и отчёта: ${user}`], 'Задание.pdf');
const SBER = { id: 'sber', name: 'Сбербанк' };
const run = (rep, items, { fields = { purpose: 'bank', bank: 'sber' }, order_bank = SBER, assignment = [], service = 'realty' } = {}) =>
  runAutoChecks(['bank_accredited'], [rep], { service, fields, assignment, today: '2026-11-11', bankAccr: { order_bank, items } }).bank_accredited;

test('правило: аккредитация на дату отчёта — своя или организации; нет, истекла, ещё не было — находка', () => {
  const ok = { bank: 'sber', title: 'Сбербанк', issued_on: '2026-01-10', valid_until: '2027-01-10', via: 'self' };
  assert.deepEqual(run(report('01.11.2026'), [ok]), []);
  assert.deepEqual(run(report('01.11.2026'), [{ ...ok, via: 'org', org_name: 'Тест' }]), [], 'через организацию');
  assert.deepEqual(run(report('01.11.2026'), [{ ...ok, issued_on: null, valid_until: null }]), [], 'без дат — действует');
  // Нет совсем — находка у строки о пользователе.
  const none = run(report('01.11.2026'), []);
  assert.equal(none.length, 1);
  assert.equal(none[0].text, 'Отчёт для банка «Сбербанк», а аккредитации в этом банке нет ни в досье эксперта, ни у его организации — банк может не принять отчёт; если аккредитация есть, внесите её в досье');
  assert.equal(none[0].quote, 'Предполагаемый пользователь результатов оценки: ПАО Сбербанк');
  // Аккредитация в другом банке — как нет.
  assert.equal(run(report('01.11.2026'), [{ ...ok, bank: 'other', title: 'Банк ВТБ' }]).length, 1);
  // Истекла до даты отчёта (а сегодня — тоже), организации — с названием.
  const old = run(report('01.11.2026'), [{ ...ok, valid_until: '2026-10-20', via: 'org', org_name: 'Тестовая организация' }]);
  assert.equal(old[0].text, 'Аккредитация в банке «Сбербанк» организации «Тестовая организация» действует до 20.10.2026, а отчёт составлен 01.11.2026 — на дату отчёта срок истёк; банк может не принять отчёт');
  // Решение банка позже даты отчёта.
  const late = run(report('01.11.2026'), [{ ...ok, issued_on: '2026-11-05' }]);
  assert.equal(late[0].text, 'Аккредитация в банке «Сбербанк» в досье эксперта — по решению от 05.11.2026, а отчёт составлен 01.11.2026 — на дату отчёта аккредитации ещё не было');
  // Старая истекла, новая действует — без находки; даты в отчёте нет — сверка с сегодняшним днём.
  assert.deepEqual(run(report('01.11.2026'), [{ ...ok, valid_until: '2026-01-01' }, ok]), []);
  const today = run(doc(['ОТЧЁТ ОБ ОЦЕНКЕ\nЦель оценки: для залога']), [{ ...ok, valid_until: '2026-11-10' }]);
  assert.match(today[0].text, /а сегодня 11\.11\.2026 — на дату отчёта срок истёк/);
  assert.equal(today[0].quote, '');
});

test('правило: «другой банк» — банк из задания на оценку, своя аккредитация — по названию; не банк, не оценка — молчим', () => {
  const other = { fields: { purpose: 'bank', bank: 'other' }, order_bank: null };
  const vtb = { bank: 'other', title: 'Банк ВТБ (ПАО)', issued_on: null, valid_until: '2027-01-01', via: 'self' };
  assert.deepEqual(run(report('01.11.2026', 'Банк ВТБ (ПАО)'), [vtb], { ...other, assignment: [task('Банк ВТБ (ПАО)')] }), []);
  const miss = run(report('01.11.2026', 'Банк ВТБ (ПАО)'), [], { ...other, assignment: [task('Банк ВТБ (ПАО)')] });
  assert.match(miss[0].text, /^Отчёт для банка «Банк ВТБ \(ПАО\)» \(в задании на оценку «Задание\.pdf»\), а аккредитации в этом банке нет/);
  // Другой банк без задания — какой банк, не узнать: молчим.
  assert.deepEqual(run(report('01.11.2026', 'Банк ВТБ (ПАО)'), [], other), []);
  // Цель не «банк», не оценка, без сведений об аккредитациях (нет эксперта) — молчим.
  assert.deepEqual(run(report('01.11.2026'), [], { fields: { purpose: 'deal', bank: 'sber' } }), []);
  assert.deepEqual(run(report('01.11.2026'), [], { service: 'handwriting' }), []);
  assert.deepEqual(runAutoChecks(['bank_accredited'], [report('01.11.2026')], { service: 'realty', fields: { purpose: 'bank', bank: 'sber' } }).bank_accredited, []);
});

let S, owner, dispatcher, spec, head;
before(async () => {
  S = await startApp();
  owner = await login(S, '+79990004581');
  dispatcher = await login(S, '+79990004582');
  spec = await login(S, '+79990004583');
  head = await login(S, '+79990004584');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

test('ИИ-проверка дела для Сбербанка: без аккредитации — находка в пункте «Сведения по закону об оценке», с аккредитацией организации — нет', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  const fields = { purpose: 'bank', bank: 'sber', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 8' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 15), fields })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const made = todayMsk().split('-').reverse().join('.');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`Отчёт об оценке квартиры № 7\nДата составления отчёта: ${made}\nПредполагаемый пользователь результатов оценки: ПАО Сбербанк\nИтог 9 000 000 руб.`), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status, 201);
  const found = async () => {
    S.providers.ai.reset();
    const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
    assert.equal(ai.status, 201, JSON.stringify(ai.body));
    return (ai.body.ai.items.find((i) => i.id === 'appraiser').found ?? []).filter((f) => /аккредитац/i.test(f.text));
  };
  const first = await found();
  assert.equal(first.length, 1);
  assert.match(first[0].text, /^Отчёт для банка «Сбербанк», а аккредитации в этом банке нет/);
  // Аккредитация организации, где эксперт состоит и от которой работает, — находки нет.
  const org = await makeOrg(S.sql, 'Тестовая организация 2.458');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, spec.user.id, 'member');
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${spec.user.id}`;
  const add = await head.req('POST', `/api/orgs/${org.id}/accreditations`, { bank: 'sber', valid_until: addDays(todayMsk(), -1) });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const expired = await found();
  assert.equal(expired.length, 1);
  assert.match(expired[0].text, /организации «Тестовая организация 2\.458» действует до .* — на дату отчёта срок истёк/);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/accreditations`, { bank: 'sber', valid_until: addDays(todayMsk(), 100) })).status, 201);
  assert.deepEqual(await found(), []);
});
