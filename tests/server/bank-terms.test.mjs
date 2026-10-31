// Срок аккредитации в банке кончается (2.454): своя аккредитация и организации — строкой в «Сегодня» эксперта и
// руководителя за 30 дней и 30 дней после; продлена (новая запись в том же банке) — не показывается; в декабре — и те, что
// кончаются до 15 января. Уведомления: своя — эксперту и руководителю, организации — руководителю и её экспертам, по разу.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeSpecialist, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { pickBankTerms, remindOrgAccreditations, bankTermsOf } from '../../src/dossier/bank-terms.mjs';
import { remindDossier } from '../../src/dossier/dossier.mjs';

let S, head, expert, org;
const today = todayMsk();

before(async () => {
  S = await startApp();
  head = await login(S, '+79990004561');
  expert = await login(S, '+79990004562');
  await makeSpecialist(S.sql, expert.user.id);
  org = await makeOrg(S.sql, 'Тестовая организация 2.454');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, expert.user.id, 'member');
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${expert.user.id}`;
  await S.sql`update users set full_name = 'Тестов Эксперт' where id = ${expert.user.id}`;
});
after(async () => { await S?.close(); });

const t = async (u) => (await u.req('GET', '/api/today')).body;
const ev = async (u, like) => (await S.sql`select event from notifications where user_id = ${u.user.id} and event like ${like} order by id`).map((r) => r.event);

test('pickBankTerms: окно 30 дней до и после, продлена — не показывать, декабрь — до 15 января', () => {
  const day = '2026-11-10';
  const rows = [
    { id: 1, bank: 'sber', title: 'Сбербанк', valid_until: '2026-12-01' },
    { id: 2, bank: 'other', title: 'Банк Тест', valid_until: '2026-11-05' },
    { id: 3, bank: 'other', title: 'Банк Далёкий', valid_until: '2026-12-31' },
    { id: 4, bank: 'other', title: 'Банк Старый', valid_until: '2026-09-01' },
  ];
  assert.deepEqual(pickBankTerms(rows, day).map((x) => [x.id, x.expired]), [['1', false], ['2', true]]);
  // Продлена: новая запись в том же банке позже окна; свой банк — по названию.
  const renewed = [...rows, { id: 5, bank: 'sber', title: 'Сбербанк', valid_until: '2027-12-01' }, { id: 6, bank: 'other', title: 'банк тест', valid_until: null }];
  assert.deepEqual(pickBankTerms(renewed, day).map((x) => x.id), []);
  // Декабрь, до каникул — и кончающиеся до 15 января, с пометкой.
  const dec = pickBankTerms([{ id: 7, bank: 'sber', title: 'Сбербанк', valid_until: '2027-01-14' }], '2026-12-05');
  assert.deepEqual(dec.map((x) => [x.id, x.new_year]), [['7', true]]);
  assert.deepEqual(pickBankTerms([{ id: 7, bank: 'sber', title: 'Сбербанк', valid_until: '2027-01-14' }], '2026-11-05'), []);
});

test('«Сегодня» эксперта и руководителя: своя и организации; продлил — строки нет', async () => {
  const own = await S.sql.one`insert into dossier_items (user_id, kind, title, bank, number, valid_until)
              values (${expert.user.id}, 'bank', 'Сбербанк', 'sber', 'Р-7', ${addDays(today, 20)}) returning id`;
  const oa = await S.sql.one`insert into org_accreditations (org_id, bank, title, valid_until, created_by)
              values (${org.id}, 'other', 'Банк Тестовый', ${addDays(today, -3)}, ${head.user.id}) returning id`;
  let e = (await t(expert)).expert.bank_terms;
  assert.deepEqual(e.items.map((x) => [x.source, x.title, x.expired]), [['org', 'Банк Тестовый', true], ['own', 'Сбербанк', false]]);
  assert.equal(e.items[0].org_id, org.id);
  assert.equal(e.items[0].org_name, 'Тестовая организация 2.454');
  const g = (await t(head)).orgs.find((x) => x.id === org.id).bank_terms;
  assert.deepEqual(g.items.map((x) => [x.source, x.expert ?? null, x.title]), [['org', null, 'Банк Тестовый'], ['own', 'Тестов Эксперт', 'Сбербанк']]);
  assert.equal('number' in g.items[1], false, 'номер аккредитации эксперта руководителю не нужен');
  // Эксперт продлил свою — новая запись в досье; организация — новая запись.
  await S.sql`insert into dossier_items (user_id, kind, title, bank, valid_until) values (${expert.user.id}, 'bank', 'Сбербанк', 'sber', ${addDays(today, 400)})`;
  await S.sql`insert into org_accreditations (org_id, bank, title, valid_until, created_by) values (${org.id}, 'other', 'банк тестовый', null, ${head.user.id})`;
  assert.equal((await t(expert)).expert.bank_terms, null);
  assert.equal((await t(head)).orgs.find((x) => x.id === org.id).bank_terms, null);
  await S.sql`update dossier_items set deleted_at = now() where user_id = ${expert.user.id} and kind = 'bank' and id <> ${own.id}`;
  await S.sql`update org_accreditations set deleted_at = now() where org_id = ${org.id} and id <> ${oa.id}`;
  // Истекла больше 30 дней назад — из «Сегодня» уходит (в досье и карточке остаётся).
  assert.equal((await bankTermsOf(S.sql, expert.user.id, addDays(today, 28))).items.length, 1);
});

test('уведомления: своя — эксперту и руководителю своими словами; организации — руководителю и экспертам, по разу', async () => {
  await S.sql`update org_accreditations set valid_until = ${addDays(today, 25)} where org_id = ${org.id} and deleted_at is null`;
  await remindDossier(S.sql, { today });
  await remindDossier(S.sql, { today });
  assert.deepEqual(await ev(expert, 'bank_accr%'), ['bank_accr_month']);
  assert.deepEqual(await ev(head, 'bank_accr%'), ['bank_accr_month_head']);
  assert.deepEqual(await ev(expert, 'dossier%'), [], 'не «документ в досье»');
  await remindOrgAccreditations(S.sql, { today });
  await remindOrgAccreditations(S.sql, { today });
  assert.deepEqual(await ev(head, 'org_accr%'), ['org_accr_month']);
  assert.deepEqual(await ev(expert, 'org_accr%'), ['org_accr_month_staff']);
  await remindOrgAccreditations(S.sql, { today: addDays(today, 20) });
  await remindOrgAccreditations(S.sql, { today: addDays(today, 26) });
  assert.deepEqual(await ev(head, 'org_accr%'), ['org_accr_month', 'org_accr_week', 'org_accr_expired']);
  assert.deepEqual(await ev(expert, 'org_accr%'), ['org_accr_month_staff', 'org_accr_expired_staff']);
  // Продлена новой записью — о прежней больше не напоминать; истекла давно — тоже.
  await S.sql`insert into org_accreditations (org_id, bank, title, valid_until, created_by) values (${org.id}, 'other', 'Банк Тестовый', ${addDays(today, 500)}, ${head.user.id})`;
  await S.sql`delete from org_accreditation_reminders`;
  assert.equal(await remindOrgAccreditations(S.sql, { today: addDays(today, 26) }), 0);
  // СМС — без названия банка.
  const sms = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                          where n.user_id = ${head.user.id} and n.event like 'org_accr%'`;
  assert.ok(sms.every((r) => !/Тестовый/.test(r.body)));
});
