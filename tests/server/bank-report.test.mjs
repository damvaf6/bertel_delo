// 2.459: сводка за месяц у руководителя — сданные дела для банков по банкам и сколько из них без аккредитации в этом банке
// на день сдачи (своей у эксперта или у организации). «Другой банк» — отдельной строкой, по аккредитации не сверяется.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('сводка за месяц — дела по банкам, без аккредитации на день сдачи; по экспертам; таблица для Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Банки в сводке»');
  const head = await login(S, '+79990004591');
  const a = await login(S, '+79990004592');
  const b = await login(S, '+79990004593');
  const owner = await login(S, '+79990004594');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт Банков А'], [b, 'Эксперт Банков Б']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await S.sql`update org_members set created_at = now() - interval '120 days' where org_id = ${org.id}`;
  await S.sql`update organizations set created_at = now() - interval '120 days' where id = ${org.id}`;
  const d = new Date(`${todayMsk().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d.toISOString().slice(0, 7);
  const done = async (executor, fields, day) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Банк 2.459' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual(r.by_bank, [], 'дел для банка нет');
  assert.equal(r.total.bank_listed, 0);

  // А: своя аккредитация в Сбербанке до 15-го — дело 10-го с ней, дело 20-го без неё.
  await S.sql`insert into dossier_items (user_id, kind, title, bank, valid_until)
              values (${a.user.id}, 'bank', 'Сбербанк', 'sber', ${`${month}-15`})`;
  await done(a.user.id, { purpose: 'bank', bank: 'sber' }, '10');
  await done(a.user.id, { purpose: 'bank', bank: 'sber' }, '20');
  // Б: аккредитации нет, а решение банка для организации пришло 21-го — дело 05-го без неё, 25-го с ней (у А дело 20-го — ещё без неё).
  await S.sql`insert into org_accreditations (org_id, bank, title, issued_on, created_by)
              values (${org.id}, 'sber', 'Сбербанк', ${`${month}-21`}, ${head.user.id})`;
  await done(b.user.id, { purpose: 'bank', bank: 'sber' }, '05');
  await done(b.user.id, { purpose: 'bank', bank: 'sber' }, '25');
  // «Другой банк» — не сверяется; цель не банк — не в счёт.
  await done(b.user.id, { purpose: 'bank', bank: 'other' }, '15');
  await done(b.user.id, { purpose: 'deal' }, '16');

  r = await report();
  assert.deepEqual(r.by_bank, [{ id: 'sber', name: 'Сбербанк', done: 4, no_accr: 2 }, { id: 'other', name: 'Другой банк', done: 1, no_accr: null }]);
  const row = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual([row(a).bank_listed, row(a).bank_no_accr], [2, 1]);
  assert.deepEqual([row(b).bank_listed, row(b).bank_no_accr], [2, 1]);
  assert.deepEqual([r.total.bank_listed, r.total.bank_no_accr], [4, 2]);

  // Аккредитация организации, где эксперт не состоит, и удалённая — не в счёт.
  const other = await makeOrg(S.sql, 'ООО «Чужая аккредитация»');
  await S.sql`insert into org_accreditations (org_id, bank, title, created_by) values (${other.id}, 'sber', 'Сбербанк', ${head.user.id})`;
  await S.sql`insert into dossier_items (user_id, kind, title, bank, deleted_at)
              values (${a.user.id}, 'bank', 'Сбербанк', 'sber', now())`;
  assert.equal((await report()).total.bank_no_accr, 2);

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Дела по банкам;Сдано;Без аккредитации в этом банке на день сдачи/);
  assert.match(text, /Сбербанк;4;2/);
  assert.match(text, /Другой банк;1;не сверяется/);
  assert.match(text, /Эксперт Банков А;2;1/);
  assert.match(text, /Итого;4;2/);
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
