// Проверка юриста перед соглашением (задача штаба 40217197-…-81f7, решение Дамира 23.10.2026): ФИО → совпадения в реестре
// адвокатов → карточка (реестр, опубликованные решения судов) без исходов и без других участников дел; «о чём дело» —
// от модели один раз, потом из сохранённого; «Подтвердить» / «Оспорить» у карточки и дела. Пока Дамир не посмотрел —
// только администратор. Юристы вымышленные, учебные данные (+7999000xxxx).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole } from '../helpers.mjs';
import { subjectFrom, withoutParties, searchName } from '../../src/lawyers/check.mjs';

let S, admin, owner, dispatcher;
const NAME = 'Пробный Адвокат Иванович';
const card = (c, reg = '77/99001', name = NAME) => c.req('GET', `/api/lawyer-check/card?reg=${encodeURIComponent(reg)}&name=${encodeURIComponent(name)}`);

before(async () => {
  S = await startApp();
  admin = await login(S, '+79990000971');
  owner = await login(S, '+79990000972');
  dispatcher = await login(S, '+79990000973');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
});
after(async () => { await S?.close(); });

test('участники дел убираются из фразы модели; ФИО для поиска — только буквы', () => {
  assert.equal(withoutParties('О взыскании долга с ООО «Ромашка» в пользу Петрова П.П.'), 'О взыскании долга с (участник скрыт) в пользу (участник скрыт)');
  assert.equal(withoutParties('Спор о разделе имущества супругов Кузнецовой К. К. и Кузнецова К.К'), 'Спор о разделе имущества супругов (участник скрыт) и (участник скрыт)');
  assert.equal(subjectFrom('«О поставке товара для АО «Альфа»»\nПояснение модели'), 'О поставке товара для (участник скрыт)');
  assert.equal(subjectFrom('   '), null);
  assert.equal(searchName('  пробный   адвокат '), 'пробный адвокат');
  for (const bad of ['', 'ab', '<script>', '1234', 'x'.repeat(121)]) assert.equal(searchName(bad), null, bad);
});

test('поиск по ФИО: однофамильцы списком, без статуса адвоката — понятная подсказка', async () => {
  const r = await admin.req('GET', `/api/lawyer-check?name=${encodeURIComponent('пробный адвокат')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lawyers.map((l) => l.reg_no), ['77/99001', '50/99002']);
  assert.ok(r.body.lawyers.every((l) => l.fictional), 'вымышленные помечены');
  const none = await admin.req('GET', `/api/lawyer-check?name=${encodeURIComponent('Нет Такого Человека')}`);
  assert.deepEqual(none.body.lawyers, []);
  assert.match(none.body.note, /без статуса адвоката в реестр не входит/);
  assert.equal((await admin.req('GET', '/api/lawyer-check?name=1')).status, 400);
});

test('карточка: реестр и дела без исходов и участников; «о чём» модель пишет один раз', async () => {
  const r = await card(admin);
  assert.equal(r.status, 200);
  const c = r.body.card;
  assert.equal(c.registry.status_name, 'Статус адвоката действует');
  assert.equal(c.registry.chamber, 'Адвокатская палата г. Москвы');
  assert.deepEqual(c.cases.map((x) => x.number), ['2-1001/2026', 'А40-2002/2025'], 'новые сверху');
  assert.equal(c.cases[0].subject, 'О взыскании долга по договору займа');
  assert.equal(c.cases[1].subject, 'О поставке некачественного товара для (участник скрыт)');
  const all = JSON.stringify(r.body);
  for (const word of ['Ромашка', 'Петров', 'Сидоров', 'Альфа', 'выигр', 'проигр', 'процент', 'outcome']) assert.ok(!all.includes(word), word);
  assert.ok(!c.cases.some((x) => 'text' in x), 'текст решения наружу не отдаётся');
  const used = async () => (await S.sql`select count(*)::int as n from ai_usage where user_id = ${admin.user.id} and purpose = 'lawyer'`)[0].n;
  assert.equal(await used(), 2);
  await card(admin);
  assert.equal(await used(), 2, 'повторно модель не спрашивается');

  const ended = (await card(admin, '77/99003', 'Учебная Юристка Сергеевна')).body.card;
  assert.equal(ended.registry.status_name, 'Статус прекращён');
  const empty = (await card(admin, '50/99002', 'Пробный Адвокат Петрович')).body.card;
  assert.equal(empty.cases.length, 0);
  assert.match(empty.cases_note, /не нашлось/);
});

test('подменённый номер реестра или ФИО — «не найдено»; модель недоступна — карточка без «о чём»', async () => {
  assert.equal((await card(admin, '77/99002')).status, 404, 'номер не того человека');
  assert.equal((await card(admin, '../etc')).status, 404);
  assert.equal((await card(admin, '77/99001', 'Учебная Юристка')).status, 404);
  await S.sql`delete from lawyer_case_subjects`;
  S.providers.ai.script({ kind: 'fail' });
  try {
    const r = await card(admin);
    assert.equal(r.status, 200);
    assert.ok(r.body.card.cases.every((x) => x.subject === null));
  } finally { S.providers.ai.script(null); }
});

test('«Подтвердить» и «Оспорить» — у карточки и у дела; оспорить — только с пояснением', async () => {
  const mark = (body) => admin.req('POST', '/api/lawyer-check/marks', { reg: '77/99001', name: NAME, ...body });
  assert.equal((await mark({ kind: 'dispute' })).status, 400);
  assert.equal((await mark({ kind: 'maybe' })).status, 400);
  assert.equal((await mark({ kind: 'confirm', case: 'fake-3' })).status, 404, 'дело другого юриста');
  assert.equal((await mark({ kind: 'confirm' })).status, 201);
  const r = await mark({ kind: 'dispute', case: 'fake-2', note: 'Это дело не этого юриста — однофамилец' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.marks.map((m) => [m.kind, m.case_key, m.mine]), [['dispute', 'fake-2', true], ['confirm', null, true]]);
  assert.equal((await card(admin)).body.marks.length, 2);
  const a = await S.sql`select action from audit_log where subject_type = 'lawyer' order by id`;
  assert.deepEqual(a.map((x) => x.action), ['lawyer_check.confirm', 'lawyer_check.dispute']);
});

test('пока Дамир не посмотрел — только администратор', async () => {
  for (const c of [owner, dispatcher]) {
    assert.equal((await c.req('GET', `/api/lawyer-check?name=${encodeURIComponent('пробный')}`)).status, 404);
    assert.equal((await card(c)).status, 404);
    assert.equal((await c.req('POST', '/api/lawyer-check/marks', { reg: '77/99001', name: NAME, kind: 'confirm' })).status, 404);
  }
});
