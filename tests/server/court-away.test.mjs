// Заседание в днях «не принимаю дела» (2.449): руководителю — группой в «Сегодня» и числом первой строкой утренней сводки
// (ведёт к отбору «Вызов в суд»), в «Делах экспертов» — пометка у заседания; эксперту — одно уведомление за 3 дня до заседания.
// Номер судебного дела руководитель не видит; с ходатайством «Не смогу прийти» — не красным и не в сводке.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { workdaysAfter } from '../../src/orders/holidays.mjs';
import { orgDigestCounts, orgDigestText, orgDigestTo, orgOffDayWorth } from '../../src/notify/morning.mjs';
import { orgPart } from '../../src/ops/today-ops.mjs';
import { warnCourtAway } from '../../src/ops/court-ops.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('2.449: заседание эксперта завтра в дни «не принимаю дела» — руководителю в «Сегодня» и утренней сводке; эксперту — за 3 дня', async () => {
  const org = await makeOrg(S.sql, 'ООО «Суд в отпуске»');
  const head = await login(S, '+79990004491');
  const exp = await login(S, '+79990004492');
  const owner = await login(S, '+79990004493');
  const free = await login(S, '+79990004494');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[exp, 'Эксперт В Отпуске'], [free, 'Эксперт На Месте']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  const today = todayMsk();
  await S.sql`update specialists set away_from = ${today}::date, away_until = ${addDays(today, 6)}::date where user_id = ${exp.user.id}`;
  const order = async (title, executor) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${addDays(today, -20)}::date, executor_user_id = ${executor} where id = ${o.id}`;
    return o;
  };
  const call = async (o, days, kind = null) => (await S.sql`
    insert into court_calls (order_id, court, case_no, hearing_at, address, created_by, side, absence_kind, absence_reason, absence_at)
    values (${o.id}, 'Тестовый районный суд', '2-4491/2026', (${addDays(today, days)}::date + '10:30'::time) at time zone 'Europe/Moscow',
            'г. Москва, тестовая ул., 49, зал 1', ${owner.user.id}, 'customer', ${kind}, ${kind ? 'болен' : null}, ${kind ? new Date() : null})
    returning id`)[0].id;
  const away = await order('Суд: эксперт не принимает дела', exp.user.id);
  const asked = await order('Суд: ходатайство подано', exp.user.id);
  const here = await order('Суд: эксперт на месте', free.user.id);
  const far = await order('Суд: через три дня', exp.user.id);
  await call(away, 1);
  await call(asked, 1, 'without');
  await call(here, 1);
  const farId = await call(far, 3);
  const ref = (o) => `№ ${o.id.slice(0, 8).toUpperCase()}`;

  // «Сегодня» руководителя: оба дела эксперта в отпуске, на месте — нет; без номера судебного дела.
  const t = (await head.req('GET', '/api/today')).body;
  const g = t.orgs.find((x) => x.id === org.id);
  const by = new Map(g.court_away.map((x) => [x.order_ref, x]));
  assert.deepEqual([by.get(ref(away)).expert, by.get(ref(away)).day, by.get(ref(away)).time, by.get(ref(away)).away_until, by.get(ref(away)).absence],
    ['Эксперт В Отпуске', addDays(today, 1), '10:30', addDays(today, 6), null]);
  assert.equal(by.get(ref(asked)).absence, 'рассмотреть без участия эксперта');
  assert.ok(!by.has(ref(here)), 'эксперт на месте — нет');
  // Через три дня — только если это следующий рабочий день (сегодня пятница — понедельник), как «Сегодня» эксперта.
  const last = [addDays(today, 1), workdaysAfter(today, 1)].sort().at(-1);
  assert.equal(by.has(ref(far)), addDays(today, 3) <= last);
  assert.ok(!JSON.stringify(g.court_away).includes('2-4491/2026'), 'номер судебного дела не виден');

  // Утренняя сводка: только без ходатайства, первой строкой и к отбору «Вызов в суд»; и в выходной — тоже.
  const c = orgDigestCounts(await orgPart(S.sql, org, S.app.locals.registry, today), today);
  assert.equal(c.court_away, addDays(today, 3) <= last ? 2 : 1);
  assert.match(orgDigestText(c), /^На сегодня по организации: заседание суда сегодня или завтра, а эксперт в этот день не принимает дела и ходатайства нет: \d дел/);
  assert.equal(orgDigestTo(c), 'court');
  assert.equal(orgOffDayWorth({ court_away: 1 }), true);

  // «Дела экспертов»: у заседания — «в этот день эксперт не принимает дела».
  const cases = new Map((await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.map((x) => [x.order_ref, x]));
  assert.equal(cases.get(ref(away)).court.next.away_until, addDays(today, 6));
  assert.equal(cases.get(ref(here)).court.next.away_until, null);

  // Эксперту: за 3 дня до заседания — одно уведомление на дело без ходатайства; повтор — нет; перенесли заседание — снова.
  const sent = async () => (await S.sql`select order_id from notifications where user_id = ${exp.user.id} and event = 'court_away' order by id`).map((r) => r.order_id);
  await warnCourtAway(S.sql);
  assert.deepEqual((await sent()).sort(), [away.id, far.id].sort());
  assert.equal(await warnCourtAway(S.sql), 0);
  await S.sql`update court_calls set hearing_at = hearing_at + interval '1 day' where id = ${farId}`;
  assert.equal(await warnCourtAway(S.sql), 0, 'через 4 дня — рано');
  await S.sql`update court_calls set hearing_at = hearing_at - interval '2 days' where id = ${farId}`;
  assert.equal(await warnCourtAway(S.sql), 1, 'заседание перенесли — по новой дате');
  // Эксперт на месте — не беспокоим.
  assert.equal((await S.sql`select count(*)::int as n from notifications where user_id = ${free.user.id} and event = 'court_away'`)[0].n, 0);
  const sms = await S.sql`select body from notification_deliveries d join notifications n on n.id = d.notification_id
                          where n.user_id = ${exp.user.id} and n.event = 'court_away'`;
  assert.ok(sms.length && sms.every((r) => r.body.includes('Не смогу прийти') && !r.body.includes('2-4491')));
});
