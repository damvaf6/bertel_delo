// Отбор «Дел экспертов» у руководителя (2.127): по эксперту — по его номеру, по сроку — «Срок на этой неделе»
// (до воскресенья включительно, просроченные тоже); завершённые и сроки после воскресенья — нет.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk, weekEnd } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, a, b, head, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 127', area: '41' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990012701');
  dispatcher = await login(S, '+79990012702');
  a = await login(S, '+79990012703');
  b = await login(S, '+79990012704');
  head = await login(S, '+79990012705');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Отбор по неделе»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [u, n] of [[a, 'Эксперт Один'], [b, 'Эксперт Два']]) {
    await makeSpecialist(S.sql, u.user.id);
    await addMember(S.sql, org.id, u.user.id, 'member');
    await u.req('PATCH', '/api/me', { full_name: n });
    { const r = await u.req('PATCH', '/api/specialist/me', { org_id: org.id }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  }
});
after(async () => { await S?.close(); });

async function taken(title, days, who) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), Math.max(days, 1)), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: o.status })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  if (days < 1) await S.sql`update orders set deadline = ${addDays(todayMsk(), days)} where id = ${o.id}`;
  return o;
}

test('weekEnd: воскресенье той же недели', () => {
  assert.equal(weekEnd('2026-10-05'), '2026-10-11', 'понедельник');
  assert.equal(weekEnd('2026-10-08'), '2026-10-11', 'четверг');
  assert.equal(weekEnd('2026-10-11'), '2026-10-11', 'воскресенье — тот же день');
  assert.equal(weekEnd('2026-12-29'), '2027-01-03', 'через год');
});

test('дела экспертов (2.127): номер эксперта у дела и «срок на этой неделе»', async () => {
  const today = todayMsk();
  const soon = await taken('Сдать сегодня', 0, a);
  const later = await taken('Сдать через три недели', 21, a);
  const late = await taken('Просрочено', -3, b);
  const done = await taken('Уже сдано', 0, b);
  await S.sql`update orders set status = 'done' where id = ${done.id}`;
  const r = await head.req('GET', `/api/orgs/${org.id}/cases`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const of = (o) => r.body.cases.find((c) => c.id === o.id);
  assert.deepEqual([soon, later, late, done].map((o) => of(o).expert_id), [a.user.id, a.user.id, b.user.id, b.user.id]);
  assert.deepEqual([soon, later, late, done].map((o) => of(o).week), [true, false, true, false]);
  // Срок до воскресенья включительно — на этой неделе; понедельник — уже нет.
  await S.sql`update orders set deadline = ${weekEnd(today)} where id = ${later.id}`;
  let c = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((x) => x.id === later.id);
  assert.equal(c.week, true, 'воскресенье');
  await S.sql`update orders set deadline = ${addDays(weekEnd(today), 1)} where id = ${later.id}`;
  c = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((x) => x.id === later.id);
  assert.equal(c.week, false, 'понедельник следующей недели');
  // Эксперт сам «Дела экспертов» не видит — номера коллег ему не раскрываются.
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/cases`)).status, 403);
});

// Дело без движения (2.133): сколько дней по делу ничего не происходило; переписка с заказчиком и его файлы не в счёт,
// файл эксперта — движение. Файл заказчика (по запросу документов) — как будто приложил заказчик: тот же файл, другой автор.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const put = (c, o, name) => c.req('POST', `/api/orders/${o.id}/results`, PDF, {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});

test('дела экспертов (2.133): «без движения» — дни с последнего события дела, переписка заказчика не в счёт', async () => {
  const idle = await taken('Без движения', 10, a);
  const fresh = await taken('Свежее', 10, b);
  await S.sql`update order_status_history set at = now() - interval '5 days 1 hour' where order_id = ${idle.id}`;
  await S.sql`update orders set updated_at = now() - interval '5 days' where id = ${idle.id}`;
  const get = async (o) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
  let c = await get(idle);
  assert.equal(c.last_move.days, 5);
  assert.equal(c.idle, true);
  c = await get(fresh);
  assert.equal(c.last_move.days, 0);
  assert.equal(c.idle, false);
  // Заказчик пишет и прикладывает файл — дело всё равно без движения.
  assert.equal((await owner.req('POST', `/api/orders/${idle.id}/messages`, { body: 'Как дела с оценкой?' })).status, 201);
  const r = await put(a, idle, 'выписка.pdf');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await S.sql`update documents set uploaded_by = ${owner.user.id} where order_id = ${idle.id}`;
  c = await get(idle);
  assert.equal(c.idle, true, 'переписка и файлы заказчика не в счёт');
  assert.equal(c.last_move.days, 5);
  // Эксперт приложил файл — движение есть.
  assert.equal((await put(a, idle, 'расчёт.pdf')).status, 201);
  c = await get(idle);
  assert.equal(c.idle, false);
  assert.equal(c.last_move.days, 0);
  // Ожидающие ответа эксперта и завершённые — без «последнего движения».
  const done = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.filter((x) => !['in_work', 'review'].includes(x.status));
  assert.ok(done.length > 0 && done.every((x) => x.last_move === null && x.idle === false));
});

// Отбор «Осмотр не закончен» (2.216): владелец нажал «Готово», сняв не всё (2.208), или ссылка кончится в ближайшие сутки,
// а «Готово» не нажато (2.196). Руководитель видит названия шагов и сроки, не фото; эксперт «Дела экспертов» не видит.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-осмотр-2.216')]);
const inspectAnon = (token, path, body, extra = {}) => client(S).req('POST', path, body, { headers: { 'x-inspect-token': token, ...extra } });
const shootStep = (token, st) => client(S).req('POST', '/api/inspect/photos', JPEG, {
  raw: true, csrf: true, headers: { 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': st },
});
async function issueLink(who, o) {
  const r = await who.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.path.split('#')[1], id: r.body.link.id };
}
const caseOf = async (o) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);

test('дела экспертов (2.216): «осмотр не закончен» — «Готово» без обязательных шагов или ссылка кончается в ближайшие сутки', async () => {
  const gap = await taken('Осмотр — снял не всё', 10, a);
  const soon = await taken('Осмотр — ссылка кончается', 10, b);
  const calm = await taken('Осмотр — ссылка на неделю', 10, a);

  const l1 = await issueLink(a, gap);
  assert.equal((await shootStep(l1.token, 'facade')).status, 201);
  assert.equal((await caseOf(gap)).inspection, null, '«Готово» не нажато, до конца ссылки далеко — нет');
  assert.equal((await inspectAnon(l1.token, '/api/inspect/finish', {})).status, 200);
  let c = await caseOf(gap);
  assert.equal(c.inspection.kind, 'incomplete');
  assert.ok(c.inspection.missing.includes('Каждая комната'));
  assert.ok(!c.inspection.missing.includes('Дом снаружи'));
  assert.equal(c.inspection.asked, 0);
  // Эксперт попросил доснять — видно, сколько просьб; новая ссылка — строка уходит.
  assert.equal((await a.req('POST', `/api/orders/${gap.id}/inspection/retakes`, { step: 'rooms', note: 'Снимите комнаты' })).status, 201);
  assert.equal((await caseOf(gap)).inspection.asked, 1);

  const l2 = await issueLink(b, soon);
  await S.sql`update inspection_links set expires_at = now() + interval '20 hours' where id = ${l2.id}`;
  c = await caseOf(soon);
  assert.equal(c.inspection.kind, 'expiring');
  assert.equal(c.inspection.photos, 0);
  assert.ok(Math.abs(new Date(c.inspection.at) - (Date.now() + 20 * 3600_000)) < 60_000);

  await issueLink(a, calm);
  assert.equal((await caseOf(calm)).inspection, null, 'ссылка на неделю — рано');

  // Продлил — строка ушла; выдал новую ссылку по делу «снял не всё» — тоже.
  assert.equal((await b.req('POST', `/api/orders/${soon.id}/inspection/extend`, { link_id: l2.id, days: 3 })).status, 200);
  assert.equal((await caseOf(soon)).inspection, null);
  await issueLink(a, gap);
  assert.equal((await caseOf(gap)).inspection, null);

  // Дело не в работе — нет; эксперт «Дела экспертов» не видит.
  const l3 = await issueLink(a, calm);
  await S.sql`update inspection_links set expires_at = now() + interval '5 hours' where id = ${l3.id}`;
  assert.equal((await caseOf(calm)).inspection.kind, 'expiring');
  await S.sql`update orders set status = 'review' where id = ${calm.id}`;
  assert.equal((await caseOf(calm)).inspection, null);
  assert.equal((await b.req('GET', `/api/orgs/${org.id}/cases`)).status, 403);
});

// 2.325: «Срок по заданию на этой неделе» — срок из задания на оценку раньше срока дела и до воскресенья включительно (прошедший
// тоже); срок дела при этом может быть далеко. Срок по заданию после воскресенья — не в отборе; позже срока дела — ничего.
test('2.325: дела экспертов — срок по заданию на оценку и отбор «на этой неделе»', async () => {
  const today = todayMsk();
  const ruD = (s) => s.split('-').reverse().join('.');
  const withTask = async (title, due) => {
    const o = await taken(title, 30, a);
    if (due != null) {
      assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(due)}`), {
        raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Задание банка Сидоровой.txt'), 'x-doc-kind': 'basis' } })).status, 201);
    }
    return o;
  };
  const now = await withTask('По заданию сегодня', today);
  const past = await withTask('По заданию вчера', addDays(today, -1));
  const sunday = await withTask('По заданию в воскресенье', weekEnd(today));
  const next = await withTask('По заданию на следующей неделе', addDays(weekEnd(today), 1));
  const after = await withTask('По заданию позже срока дела', addDays(today, 40));
  const none = await withTask('Без задания', null);
  const r = await head.req('GET', `/api/orgs/${org.id}/cases`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const of = (o) => r.body.cases.find((c) => c.id === o.id);
  assert.deepEqual([now, past, sunday, next, after, none].map((o) => [of(o).week, of(o).task_week]),
    [[false, true], [false, true], [false, true], [false, false], [false, false], [false, false]]);
  assert.deepEqual(of(now).task_due, { day: today, by: 'по заданию на оценку', overdue: false, hot: true });
  assert.deepEqual(of(past).task_due, { day: addDays(today, -1), by: 'по заданию на оценку', overdue: true, hot: true });
  assert.equal(of(next).task_due.hot, addDays(weekEnd(today), 1) <= addDays(today, 2));
  assert.equal(of(after).task_due, null);
  assert.equal(of(none).task_due, null);
  assert.ok(!JSON.stringify(r.body.cases).includes('Сидоровой'), 'без названия файла задания');
});
