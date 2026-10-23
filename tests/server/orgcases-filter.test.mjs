// Отбор «Дел экспертов» у руководителя (2.127): по эксперту — по его номеру, по сроку — «Срок на этой неделе»
// (до воскресенья включительно, просроченные тоже); завершённые и сроки после воскресенья — нет.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk, weekEnd } from '../../src/orders/workflow.mjs';
import { workingAgo } from '../../src/orders/silence.mjs';
import { idleDays } from '../../src/ops/org-ops.mjs';

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

// Отбор «Без движения 5 дней и дольше» (2.368): с пятого дня без движения — отдельная отметка `idle_long`; три-четыре дня —
// только «без движения»; файл эксперта — отметка уходит. 2.385: дни рабочие — тест не зависит от дня недели прогона.
test('дела экспертов (2.368): «без движения 5 дней и дольше» — с пятого дня', async () => {
  const long = await taken('Стоит шесть дней', 10, a);
  const four = await taken('Стоит четыре дня', 10, b);
  const five = await taken('Стоит ровно пять дней', 10, b);
  for (const [o, d] of [[long, 6], [four, 4], [five, 5]]) {
    await S.sql`update order_status_history set at = ${workingAgo(d * 86400_000 + 3600_000)} where order_id = ${o.id}`;
  }
  let [cl, cf, c5] = [await caseOf(long), await caseOf(four), await caseOf(five)];
  assert.deepEqual([cl.last_move.work_days, cf.last_move.work_days, c5.last_move.work_days], [6, 4, 5]);
  assert.ok(cl.last_move.days >= 6, 'по календарю — не меньше рабочих');
  assert.deepEqual([cl.idle, cf.idle, c5.idle], [true, true, true]);
  assert.deepEqual([cl.idle_long, cf.idle_long, c5.idle_long], [true, false, true]);
  assert.equal(cl.last_move.idle_long, true);
  // По каждому делу можно напомнить эксперту; напомнили — до завтра нельзя, отметка остаётся.
  assert.equal(cl.remind.can_remind, true);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${long.id}/remind`)).status, 201);
  cl = await caseOf(long);
  assert.equal(cl.remind.can_remind, false);
  assert.equal(cl.idle_long, true, 'напоминание — не движение дела');
  // Эксперт приложил файл — движение есть.
  assert.equal((await put(a, long, 'расчёт-2.368.pdf')).status, 201);
  cl = await caseOf(long);
  assert.equal(cl.idle_long, false);
  // Завершённые и ожидающие ответа — без отметки.
  const rest = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.filter((x) => !['in_work', 'review'].includes(x.status));
  assert.ok(rest.every((x) => x.idle_long === false));
});

// 2.385: «без движения» — в рабочих днях по Москве: выходные и нерабочие праздники не в счёт.
test('2.385: без движения — рабочие дни; после выходных и праздника не тревожит зря', () => {
  // Пятница 18:00 → понедельник 12:00: по календарю 2 дня, рабочих — меньше суток.
  assert.deepEqual(idleDays('2026-10-23T15:00:00Z', '2026-10-26T09:00:00Z'), { days: 2, work_days: 0, idle: false, idle_long: false });
  // Среда 10:00 → понедельник 12:00: по календарю 5 дней («5 дней и дольше» раньше), рабочих — 3: только «без движения».
  assert.deepEqual(idleDays('2026-10-21T07:00:00Z', '2026-10-26T09:00:00Z'), { days: 5, work_days: 3, idle: true, idle_long: false });
  // Понедельник 10:00 → понедельник 10:00 через неделю: рабочих 5 — «5 дней и дольше».
  assert.deepEqual(idleDays('2026-10-19T07:00:00Z', '2026-10-26T07:00:00Z'), { days: 7, work_days: 5, idle: true, idle_long: true });
  // 4 ноября (среда) — праздник: понедельник 2 ноября 10:00 → четверг 5 ноября 10:00 — рабочих 2, не «без движения».
  assert.deepEqual(idleDays('2026-11-02T07:00:00Z', '2026-11-05T07:00:00Z'), { days: 3, work_days: 2, idle: false, idle_long: false });
});

// Прогон 2.370: дело на проверке у диспетчера шесть дней ждёт его, а не эксперта — не «без движения» и не в отборах.
test('дела экспертов (прогон 2.370): дело на проверке у диспетчера — не «без движения»', async () => {
  const o = await taken('На проверке шесть дней', 10, a);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  await S.sql`update order_status_history set at = now() - interval '6 days 1 hour' where order_id = ${o.id}`;
  const c = await caseOf(o);
  assert.equal(c.last_move.days, 6);
  assert.equal(c.last_move.review, true);
  assert.deepEqual([c.idle, c.idle_long], [false, false]);
});


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

// 2.332: перенос срока согласован позже срока по заданию на оценку, а письма о переносе нет — у дела пометка `task_moved`
// (без названия файла задания), просили ли письмо у заказчика; пришло письмо с новым сроком — пометки нет.
test('2.332: дела экспертов — перенос позже срока по заданию, а письма о переносе нет', async () => {
  const today = todayMsk();
  const ruD = (s) => s.split('-').reverse().join('.');
  const o = await taken('Перенос позже задания', 3, a);
  const calm = await taken('Перенос не позже задания', 3, a);
  const put = (body, name, kind = 'basis') => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': kind } });
  await S.sql`update orders set fields = fields || '{"purpose":"bank"}'::jsonb where id = ${o.id}`;
  const due = addDays(today, 3);
  assert.equal((await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(due)}`, 'Задание банка Переносовой.txt')).status, 201);
  const caseOf = async (x) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === x.id);
  assert.equal((await caseOf(o)).task_moved, null, 'переноса нет');
  const late = addDays(today, 12);
  const ask = (x) => a.req('POST', `/api/orders/${x.id}/deadline-requests`, { new_deadline: late, reason: 'Банк согласовал перенос устно' });
  const r = await ask(o);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await caseOf(o)).task_moved, null, 'просьба ждёт ответа');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${r.body.open.id}/decide`, { approve: true })).status, 200);
  let c = await caseOf(o);
  assert.deepEqual(c.task_moved, { day: due, by: 'по заданию на оценку', who: 'Банк', doc: 'Письмо банка', moved_from: addDays(today, 3),
    deadline: late, asked: null, letter: null });
  // Без задания на оценку перенос — без пометки.
  const r2 = await ask(calm);
  assert.equal((await dispatcher.req('POST', `/api/orders/${calm.id}/deadline-requests/${r2.body.open.id}/decide`, { approve: true })).status, 200);
  assert.equal((await caseOf(calm)).task_moved, null);
  assert.equal(c.task_week, false, 'в отборе «Срок по заданию на этой неделе» не повторяется');
  assert.ok(!JSON.stringify(c).includes('Переносовой'), 'без названия файла задания');
  // Эксперт попросил письмо у заказчика — пометка остаётся, видно когда просили.
  const q = await a.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  c = await caseOf(o);
  assert.ok(c.task_moved.asked);
  // Письмо пришло с новым сроком — пометки нет.
  const req = q.body.requests.find((x) => x.item_id === 'task_move');
  const doc = await put(`Сообщаем, что срок составления отчёта продлён: не позднее ${ruD(late)}`, 'Письмо.txt', 'other');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req.id}/attach`, { document_id: doc.body.document.id })).status, 200);
  assert.equal((await caseOf(o)).task_moved, null);
});

// 2.348: письмо о переносе пришло, а срок в нём раньше срока дела — у дела `task_moved.letter` и `letter_due`: сколько дней
// осталось и близко ли (прошёл или через 1–2 дня); дальше — не красным.
test('2.348: дела экспертов — сдать по письму о переносе, срок в нём раньше срока дела', async () => {
  const today = todayMsk();
  const ruD = (s) => s.split('-').reverse().join('.');
  const caseOf = async (x) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === x.id);
  const late = addDays(today, 12);
  const letterCase = async (title, letterDay) => {
    const o = await taken(title, 3, a);
    const put = (body, name, kind = 'basis') => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
      raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': kind } });
    await S.sql`update orders set fields = fields || '{"purpose":"bank"}'::jsonb where id = ${o.id}`;
    assert.equal((await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(addDays(today, 1))}`, 'Задание.txt')).status, 201);
    const r = await a.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: late, reason: 'Банк согласовал перенос устно' });
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${r.body.open.id}/decide`, { approve: true })).status, 200);
    const q = await a.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
    const req = q.body.requests.find((x) => x.item_id === 'task_move');
    const doc = await put(`Банк сообщает: срок составления отчёта продлён, не позднее ${ruD(letterDay)}`, 'Письмо о переносе.txt', 'other');
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req.id}/attach`, { document_id: doc.body.document.id })).status, 200);
    return o;
  };
  const near = await letterCase('Письмо с коротким сроком', addDays(today, 2));
  const far = await letterCase('Письмо со сроком позже', addDays(today, 6));
  let c = await caseOf(near);
  assert.equal(c.task_moved.day, addDays(today, 2));
  assert.deepEqual(c.task_moved.letter, { was: addDays(today, 1) });
  assert.deepEqual(c.task_moved.letter_due, { days_left: 2, overdue: false, hot: true });
  c = await caseOf(far);
  assert.deepEqual(c.task_moved.letter_due, { days_left: 6, overdue: false, hot: false });
  assert.ok(!JSON.stringify(c).includes('Письмо о переносе.txt'), 'без названия файла');
  // Без письма — `letter_due` нет (2.332 не меняется).
  const none = await taken('Перенос без письма 2.348', 3, a);
  assert.equal((await caseOf(none)).task_moved, null);
});
