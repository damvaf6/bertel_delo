// Перенос срока дела (задача 2.91): исполнитель просит новую дату с причиной; диспетчер соглашается или отказывает;
// заказчик видит; новый срок — в заявке, «Сегодня» и напоминаниях; история переносов и журнал.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { remindDeadlines } from '../../src/notify/reminders.mjs';

let S, owner, dispatcher, spec, stranger, other;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Сроковая ул., 3' };
const today = todayMsk();

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990002911');
  dispatcher = await login(S, '+79990002912');
  spec = await login(S, '+79990002913');
  stranger = await login(S, '+79990002914');
  other = await login(S, '+79990002915');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  await makeSpecialist(S.sql, other.user.id);
});
after(async () => { await S?.close(); });

async function inWork(title, days = 3) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, days), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}
const events = async (u, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${u.user.id} and event = ${event}`)[0].n;
const list = (c, o) => c.req('GET', `/api/orders/${o.id}/deadline-requests`);
const ask = (c, o, body) => c.req('POST', `/api/orders/${o.id}/deadline-requests`, body);
const decide = (c, o, rid, body) => c.req('POST', `/api/orders/${o.id}/deadline-requests/${rid}/decide`, body);

test('исполнитель просит перенести срок — диспетчер соглашается: новый срок в заявке, «Сегодня», напоминаниях, журнале', async () => {
  const o = await inWork('Квартира: перенос срока', 3);
  const old = addDays(today, 3);
  const want = addDays(today, 10);
  // Видят все стороны; просит только исполнитель.
  assert.equal((await list(stranger, o)).status, 404);
  assert.equal((await list(owner, o)).body.can_request, false);
  assert.equal((await list(dispatcher, o)).body.can_request, false);
  assert.equal((await list(spec, o)).body.can_request, true);
  assert.equal((await ask(owner, o, { new_deadline: want, reason: 'хочу' })).status, 403);
  assert.equal((await ask(dispatcher, o, { new_deadline: want, reason: 'хочу' })).status, 403);
  assert.equal((await ask(stranger, o, { new_deadline: want, reason: 'хочу' })).status, 404);
  // Проверки ввода: дата позже нынешней, причина обязательна, не дальше двух лет.
  assert.equal((await ask(spec, o, { new_deadline: old, reason: 'x' })).body.error, 'not_later');
  assert.equal((await ask(spec, o, { new_deadline: '2026-02-30', reason: 'x' })).body.error, 'bad_date');
  assert.equal((await ask(spec, o, { new_deadline: addDays(today, 800), reason: 'x' })).body.error, 'deadline_far');
  assert.equal((await ask(spec, o, { new_deadline: want, reason: '  ' })).status, 400);
  assert.equal((await ask(spec, o, { new_deadline: want, reason: 'x', from: addDays(today, 1) })).body.error, 'status_changed');
  const r = await ask(spec, o, { new_deadline: want, reason: 'Росреестр не выдал выписку ЕГРН', from: old });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.open.new_deadline, want);
  assert.equal(r.body.can_request, false, 'вторую просьбу не подать, пока нет ответа');
  assert.equal(r.body.can_withdraw, true);
  assert.equal((await ask(spec, o, { new_deadline: addDays(today, 12), reason: 'ещё' })).body.error, 'already_requested');
  assert.equal(await events(dispatcher, 'deadline_ext_requested'), 1);
  // Заказчик видит просьбу, но не решает.
  const seen = (await list(owner, o)).body;
  assert.equal(seen.open.reason, 'Росреестр не выдал выписку ЕГРН');
  assert.equal(seen.can_decide, false);
  const rid = seen.open.id;
  assert.equal((await decide(owner, o, rid, { approve: true })).status, 403);
  assert.equal((await decide(spec, o, rid, { approve: true })).status, 403);
  assert.equal((await decide(stranger, o, rid, { approve: true })).status, 404);
  assert.equal((await decide(dispatcher, o, rid, {})).status, 400);
  // «Сегодня» диспетчера: строка «Просят перенести срок».
  const t = (await dispatcher.req('GET', '/api/today')).body.dispatcher;
  const line = t.extend.find((x) => x.id === o.id);
  assert.equal(line.new_deadline, want);
  assert.equal(line.reason, 'Росреестр не выдал выписку ЕГРН');
  // Согласие: срок заявки — новый; исполнителю и заказчику — уведомление.
  const d = await decide(dispatcher, o, rid, { approve: true, answer: 'Согласовано с заказчиком' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.open, null);
  assert.equal(d.body.deadline, want);
  assert.equal(d.body.requests[0].outcome, 'approved');
  assert.equal((await decide(dispatcher, o, rid, { approve: false })).body.error, 'already_decided');
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.order.deadline, want);
  assert.equal(await events(spec, 'deadline_ext_approved'), 1);
  assert.equal(await events(owner, 'deadline_moved'), 1);
  assert.ok(!(await dispatcher.req('GET', '/api/today')).body.dispatcher.extend.some((x) => x.id === o.id));
  // «Горит срок» у эксперта — уже нет (до нового срока 10 дней); напоминание «через 3 дня» — по новому сроку.
  assert.ok(!(await spec.req('GET', '/api/today')).body.expert.hot.some((x) => x.id === o.id));
  await remindDeadlines(S.sql, { today });
  assert.equal(await events(spec, 'deadline_soon'), 0, 'по старому сроку напоминания нет');
  await remindDeadlines(S.sql, { today: addDays(today, 7) });
  assert.equal(await events(spec, 'deadline_soon'), 1, 'по новому — есть');
  // Журнал — заказчику видна история переносов.
  const journal = (await owner.req('GET', `/api/orders/${o.id}/journal`)).body.journal.map((j) => j.what);
  const ru = (iso) => iso.split('-').reverse().join('.');
  assert.ok(journal.includes(`Исполнитель попросил перенести срок с ${ru(old)} на ${ru(want)}: Росреестр не выдал выписку ЕГРН`), journal.join('\n'));
  assert.ok(journal.includes(`Срок перенесён с ${ru(old)} на ${ru(want)}: Согласовано с заказчиком`), journal.join('\n'));
  // После ответа можно попросить снова.
  assert.equal((await list(spec, o)).body.can_request, true);
});

test('отказ и отзыв просьбы: срок прежний; по завершённому делу не решается; чужой исполнитель не просит', async () => {
  const o = await inWork('Квартира: отказ в переносе', 5);
  const old = addDays(today, 5);
  // Другой специалист (не исполнитель этого дела) — дела не видит.
  assert.equal((await ask(other, o, { new_deadline: addDays(today, 9), reason: 'x' })).status, 404);
  let r = (await ask(spec, o, { new_deadline: addDays(today, 9), reason: 'Заказчик не пускает на осмотр' })).body;
  const d = await decide(dispatcher, o, r.open.id, { approve: false, answer: 'Суд не продлит срок' });
  assert.equal(d.status, 200);
  assert.equal(d.body.deadline, old);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.order.deadline, old);
  assert.equal(await events(spec, 'deadline_ext_declined'), 1);
  const hist = (await list(owner, o)).body.requests;
  assert.equal(hist[0].outcome, 'declined');
  assert.equal(hist[0].answer, 'Суд не продлит срок');
  // Отзыв: только исполнитель; потом решать нечего.
  r = (await ask(spec, o, { new_deadline: addDays(today, 8), reason: 'Ещё раз' })).body;
  assert.equal((await owner.req('DELETE', `/api/orders/${o.id}/deadline-requests/${r.open.id}`)).status, 403);
  const w = await spec.req('DELETE', `/api/orders/${o.id}/deadline-requests/${r.open.id}`);
  assert.equal(w.status, 200);
  assert.equal(w.body.requests[0].outcome, 'withdrawn');
  assert.equal((await decide(dispatcher, o, r.open.id, { approve: true })).body.error, 'already_decided');
  // Срок заявки изменился иначе (диспетчер правил) — согласие на старую просьбу не проходит.
  r = (await ask(spec, o, { new_deadline: addDays(today, 8), reason: 'Третий раз' })).body;
  await S.sql`update orders set deadline = ${addDays(today, 6)} where id = ${o.id}`;
  assert.equal((await decide(dispatcher, o, r.open.id, { approve: true })).body.error, 'status_changed');
  // Дело отменено — решать нельзя, просить нельзя.
  await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
  assert.equal((await decide(dispatcher, o, r.open.id, { approve: true })).body.error, 'order_final');
  const after = (await list(spec, o)).body;
  assert.equal(after.can_request, false);
  assert.equal(after.can_decide, false);
  assert.equal((await ask(spec, o, { new_deadline: addDays(today, 9), reason: 'x' })).body.error, 'not_in_work');
});

test('готовые причины переноса (2.126): «жду документы с …» — дата и что просили из дела, «осмотр перенесён»; только исполнителю', async () => {
  const o = await inWork('Квартира: готовые причины', 4);
  let r = (await list(spec, o)).body;
  assert.deepEqual(r.reasons.map((x) => x.id), ['inspection'], 'документы не запрашивали — причины «жду документы» нет');
  assert.equal(r.reasons[0].reason, 'Осмотр объекта перенесён владельцем');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn', 'tech_plan'] })).status, 201);
  // Запрос сделан три дня назад — новый срок предлагается на три дня позже нынешнего.
  await S.sql`update doc_requests set requested_at = now() - interval '3 days' where order_id = ${o.id}`;
  const day = (await S.sql`select to_char(requested_at at time zone 'Europe/Moscow', 'DD.MM.YYYY') as d from doc_requests where order_id = ${o.id} limit 1`)[0].d;
  r = (await list(spec, o)).body;
  const docs = r.reasons.find((x) => x.id === 'docs');
  assert.equal(docs.label, `Жду документы с ${day}`);
  assert.equal(docs.reason, `Жду документы от заказчика с ${day}: Выписка из ЕГРН, Технический паспорт БТИ или поэтажный план`);
  assert.equal(docs.new_deadline, addDays(today, 7));
  // Заказчику, диспетчеру — без готовых причин; посторонний не видит дело.
  assert.deepEqual((await list(owner, o)).body.reasons, []);
  assert.deepEqual((await list(dispatcher, o)).body.reasons, []);
  assert.equal((await list(stranger, o)).status, 404);
  // Отправка готовой причины — обычная просьба; пока ждёт ответа, причин нет.
  const sent = await ask(spec, o, { new_deadline: docs.new_deadline, reason: docs.reason, from: addDays(today, 4) });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.open.reason, docs.reason);
  assert.deepEqual(sent.body.reasons, []);
  // Заказчик приложил всё — «жду документы» больше не предлагается.
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/deadline-requests/${sent.body.open.id}`)).status, 200);
  await S.sql`update doc_requests set cancelled_at = now() where order_id = ${o.id}`;
  assert.deepEqual((await list(spec, o)).body.reasons.map((x) => x.id), ['inspection']);
});

test('перегруженный день (2.134): больше двух дел к сдаче — день выделен в «Моих сроках», у дел «Попросить перенос» и готовая причина', async () => {
  // Свои дела — у отдельного эксперта, чтобы не смешивать со сроками прошлых проверок.
  async function inWorkFor(c, title, days) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, days), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: c.user.id, from: 'matching' })).status, 200);
    assert.equal((await c.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    return o;
  }
  const busyDay = addDays(today, 6);
  const dayOf = async () => (await other.req('GET', '/api/specialist/me/schedule')).body.schedule.days.find((d) => d.date === busyDay);
  const a = await inWorkFor(other, 'Квартира: много дел 1', 6);
  const b = await inWorkFor(other, 'Квартира: много дел 2', 6);
  let d = await dayOf();
  assert.equal(d.busy, false, 'два дела в день — не перегружен');
  assert.ok(d.items.every((i) => !i.can_extend));
  assert.ok(!(await list(other, a)).body.reasons.some((x) => x.id === 'busy'));
  const c = await inWorkFor(other, 'Квартира: много дел 3', 6);
  d = await dayOf();
  assert.equal(d.busy, true);
  assert.equal(d.due, 3);
  assert.deepEqual(d.items.filter((i) => i.kind === 'deadline').map((i) => i.can_extend), [true, true, true]);
  // Готовая причина: дата и сколько дел; новый срок — ближайший будний день после срока (других дел у эксперта нет).
  const r = (await list(other, a)).body.reasons.find((x) => x.id === 'busy');
  const [y, m, dd] = busyDay.split('-');
  assert.equal(r.label, 'Много дел в этот день (3)');
  assert.equal(r.reason, `Высокая загрузка: на ${dd}.${m}.${y} у меня к сдаче несколько дел — прошу перенести срок`);
  let next = addDays(busyDay, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00Z`).getUTCDay())) next = addDays(next, 1);
  assert.equal(r.new_deadline, next);
  // Попросил перенос по одному делу — у него кнопки больше нет, у остальных есть, пока день перегружен.
  assert.equal((await ask(other, a, { new_deadline: r.new_deadline, reason: r.reason, from: busyDay })).status, 201);
  d = await dayOf();
  const can = Object.fromEntries(d.items.filter((i) => i.kind === 'deadline').map((i) => [i.order_id, i.can_extend]));
  assert.deepEqual(can, { [a.id]: false, [b.id]: true, [c.id]: true });
  // Одно дело сдано на проверку — к сдаче два, день больше не выделен.
  await S.sql`update orders set status = 'review' where id = ${c.id}`;
  d = await dayOf();
  assert.equal(d.busy, false);
  assert.equal(d.due, 2);
  assert.ok(!(await list(other, b)).body.reasons.some((x) => x.id === 'busy'));
  // Посторонний не видит чужие дела и причины.
  assert.equal((await list(stranger, b)).status, 404);
});

// 2.179: выезд на объект в день сдачи считается за дело — два дела к сдаче и выезд помощника — день перегружен.
test('перегруженный день (2.179): два дела к сдаче и выезд помощника в тот же день — перегружен, готовая причина', async () => {
  const me = await login(S, '+79990002917');
  const helper = await login(S, '+79990002918');
  await makeSpecialist(S.sql, me.user.id);
  await makeSpecialist(S.sql, helper.user.id);
  async function inWorkFor(c, title, days) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, days), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: c.user.id, from: 'matching' })).status, 200);
    assert.equal((await c.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    return o;
  }
  const busyDay = addDays(today, 6);
  const dayOf = async (c) => (await c.req('GET', '/api/specialist/me/schedule')).body.schedule.days.find((d) => d.date === busyDay);
  const visit = (o, day) => S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at)
    values (${o.id}, ${helper.user.id}, ${me.user.id}, (${day}::date + time '11:00') at time zone 'Europe/Moscow') returning id`;
  const a = await inWorkFor(me, 'Квартира: сдача и выезд 1', 6);
  // Одно дело и выезд — не перегружен.
  const [v1] = await visit(a, busyDay);
  let d = await dayOf(me);
  assert.deepEqual([d.due, d.trips, d.busy], [1, 1, false]);
  const b = await inWorkFor(me, 'Квартира: сдача и выезд 2', 6);
  d = await dayOf(me);
  assert.deepEqual([d.due, d.trips, d.busy], [2, 1, true]);
  assert.deepEqual(d.items.filter((i) => i.kind === 'deadline').map((i) => i.can_extend), [true, true]);
  const r = (await list(me, b)).body.reasons.find((x) => x.id === 'busy');
  assert.equal(r.label, 'Много дел в этот день (2 и выезд)');
  let next = addDays(busyDay, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00Z`).getUTCDay())) next = addDays(next, 1);
  assert.equal(r.new_deadline, next);
  // В ближайший будний день после срока — дело и выезд: новый срок — следующий свободный будний.
  const c = await inWorkFor(me, 'Квартира: сдача и выезд 3', 6);
  await S.sql`update orders set deadline = ${next} where id = ${c.id}`;
  await visit(c, next);
  let after = addDays(next, 1);
  while ([0, 6].includes(new Date(`${after}T00:00:00Z`).getUTCDay())) after = addDays(after, 1);
  assert.equal((await list(me, b)).body.reasons.find((x) => x.id === 'busy').new_deadline, after);
  // У помощника в этот день только свой выезд, сдавать нечего — не перегружен.
  const h = await dayOf(helper);
  assert.deepEqual([h.due, h.trips, h.busy], [0, 1, false]);
  // Выезд отменён — два дела к сдаче, не перегружен; причины «много дел» нет.
  await S.sql`update onsite_visits set cancelled_at = now() where id = ${v1.id}`;
  d = await dayOf(me);
  assert.deepEqual([d.due, d.trips, d.busy], [2, 0, false]);
  assert.ok(!(await list(me, b)).body.reasons.some((x) => x.id === 'busy'));
  // Посторонний не видит чужие дела и причины.
  assert.equal((await list(stranger, b)).status, 404);
});

// 2.145: свой темп в блоке «Срок» — дней до срока и обычный срок эксперта по этой услуге (средний из «Сдано за год», 2.139);
// обычно нужно ещё больше, чем осталось, — мягкое предупреждение. Видит только исполнитель.
test('свой темп (2.145): дней до срока, обычный срок по услуге, «можно не успеть»; только исполнителю', async () => {
  const me = await login(S, '+79990002916');
  await makeSpecialist(S.sql, me.user.id);
  async function inWorkFor(c, title, days) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, days), fields: FIELDS })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: c.user.id, from: 'matching' })).status, 200);
    assert.equal((await c.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    return o;
  }
  const o = await inWorkFor(me, 'Квартира: свой темп', 3);
  // Сданных дел этой услуги нет — только «осталось».
  let p = (await list(me, o)).body.pace;
  assert.deepEqual([p.days_left, p.usual_days, p.late], [3, null, false]);
  assert.equal((await list(owner, o)).body.pace, null, 'заказчик темп эксперта не видит');
  assert.equal((await list(dispatcher, o)).body.pace, null);
  // Сданные за год дела той же услуги: принял 10 и 8 дней назад, сдал через 6 и 4 дня — в среднем 5. Одно дело — мало.
  async function doneCase(taken, took) {
    const d = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Сдано раньше' })).body.order;
    await S.sql`update orders set executor_user_id = ${me.user.id}, status = 'done', deadline = ${today} where id = ${d.id}`;
    await S.sql`insert into order_offers (order_id, specialist_id, score, outcome, outcome_at)
                values (${d.id}, ${me.user.id}, '{}', 'accepted', now() - make_interval(days => ${taken}))`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, actor_id, at)
                values (${d.id}, 'review', 'done', 'dispatcher', ${dispatcher.user.id}, now() - make_interval(days => ${taken - took}))`;
  }
  await doneCase(10, 6);
  assert.equal((await list(me, o)).body.pace.usual_days, null, 'одного сданного дела мало');
  await doneCase(8, 4);
  p = (await list(me, o)).body.pace;
  assert.deepEqual([p.days_left, p.usual_days, p.spent_days, p.need_days, p.late], [3, 5, 0, 5, true]);
  // Дело у эксперта уже 3 дня — по обычному темпу нужно ещё 2, до срока 3: успевает.
  await S.sql`update order_offers set outcome_at = now() - interval '3 days' where order_id = ${o.id} and specialist_id = ${me.user.id}`;
  p = (await list(me, o)).body.pace;
  assert.deepEqual([p.spent_days, p.need_days, p.late], [3, 2, false]);
  // Другая услуга — обычный срок по ней не считается.
  const v = await inWorkFor(me, 'Машина: свой темп', 1);
  await S.sql`update orders set service = 'vehicle' where id = ${v.id}`;
  p = (await list(me, v)).body.pace;
  assert.deepEqual([p.days_left, p.usual_days, p.late], [1, null, false]);
  // Сдано на проверку — темп не нужен.
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await list(me, o)).body.pace, null);
});

test('ответ диспетчера заметно (2.155): в «Сроке» и в «Сегодня» до первого просмотра; только нынешнему исполнителю', async () => {
  const o = await inWork('Квартира: ответ на перенос', 4);
  const old = addDays(today, 4);
  const want = addDays(today, 11);
  const expert = async () => (await spec.req('GET', '/api/today')).body.expert.extend_answer.find((x) => x.id === o.id);
  let r = (await ask(spec, o, { new_deadline: want, reason: 'Жду выписку', from: old })).body;
  assert.equal(r.fresh_answer, null, 'ответа ещё нет');
  assert.equal(await expert(), undefined);
  await decide(dispatcher, o, r.open.id, { approve: true, answer: 'Согласовано с заказчиком' });
  // Заказчик и диспетчер, открывая «Срок», ответ «увиденным» не делают.
  assert.equal((await list(owner, o)).body.fresh_answer, null);
  assert.equal((await list(dispatcher, o)).body.fresh_answer, null);
  const line = await expert();
  assert.equal(line.outcome, 'approved');
  assert.equal(line.old_deadline, old);
  assert.equal(line.new_deadline, want);
  assert.equal(line.deadline, want, 'в строке уже новый срок');
  assert.equal(line.answer, 'Согласовано с заказчиком');
  assert.equal((await owner.req('GET', '/api/today')).body.expert, null, 'заказчику — не эксперту — строки нет');
  // Эксперт открыл дело — ответ показан один раз, из «Сегодня» строка ушла.
  const first = (await list(spec, o)).body.fresh_answer;
  assert.equal(first.outcome, 'approved');
  assert.equal(first.new_deadline, want);
  assert.equal(first.answer, 'Согласовано с заказчиком');
  assert.equal((await list(spec, o)).body.fresh_answer, null);
  assert.equal(await expert(), undefined);
  // Отказ без пояснения — тоже заметно; отзыв своей просьбы — не ответ.
  r = (await ask(spec, o, { new_deadline: addDays(want, 3), reason: 'Ещё неделя' })).body;
  await decide(dispatcher, o, r.open.id, { approve: false });
  const no = await expert();
  assert.equal(no.outcome, 'declined');
  assert.equal(no.answer, null);
  assert.equal(no.deadline, want);
  r = (await ask(spec, o, { new_deadline: addDays(want, 2), reason: 'Попробую ещё' })).body;
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/deadline-requests/${r.open.id}`)).status, 200);
  assert.equal(await expert(), undefined, 'после отзыва старый отказ уже не новость');
  assert.equal((await list(spec, o)).body.fresh_answer, null);
  // Чужой специалист «Срока» не видит и ответа не получает.
  assert.equal((await list(other, o)).status, 404);
  assert.equal(((await other.req('GET', '/api/today')).body.expert?.extend_answer ?? []).some((x) => x.id === o.id), false);
});

test('просроченное дело (2.166): в «Сегодня» — без просьбы о переносе; новый срок — не раньше сегодня, готовая причина тоже', async () => {
  const o = await inWork('Квартира: срок прошёл', 3);
  const past = addDays(today, -4);
  await S.sql`update orders set deadline = ${past} where id = ${o.id}`;
  const hot = async () => (await spec.req('GET', '/api/today')).body.expert.hot.find((x) => x.id === o.id);
  let h = await hot();
  assert.equal(h.overdue, true);
  assert.equal(h.extend, null, 'перенос не просили — в «Сегодня» кнопка «Попросить перенести срок»');
  // Самый ранний новый срок — сегодня (а не день после прошедшего срока).
  let r = (await list(spec, o)).body;
  assert.equal(r.min_new, today);
  assert.equal((await list(owner, o)).body.min_new, null);
  // Документы ждут 2 дня: «срок + 2 дня» уже прошёл — готовая причина предлагает сегодня.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn'] })).status, 201);
  await S.sql`update doc_requests set requested_at = now() - interval '2 days' where order_id = ${o.id}`;
  r = (await list(spec, o)).body;
  assert.equal(r.reasons.find((x) => x.id === 'docs').new_deadline, today);
  // Дата позже прошедшего срока, но тоже в прошлом — нельзя.
  assert.equal((await ask(spec, o, { new_deadline: addDays(today, -1), reason: 'Жду выписку' })).body.error, 'in_past');
  const sent = await ask(spec, o, { new_deadline: addDays(today, 3), reason: 'Жду выписку', from: past });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  // Просьба есть — в «Сегодня» видно, на какую дату; второй раз не предлагается.
  h = await hot();
  assert.equal(h.extend.new_deadline, addDays(today, 3));
  // У дела со сроком в будущем самый ранний новый срок — день после нынешнего, как раньше.
  const f = await inWork('Квартира: срок впереди', 5);
  assert.equal((await list(spec, f)).body.min_new, addDays(today, 6));
});

// 2.169: в «Сроке» — сколько раз уже переносили и на сколько дней всего; считаются только согласованные просьбы.
test('сколько раз переносили срок (2.169): число, всего дней, первоначальный срок; отказ и отзыв не считаются', async () => {
  const o = await inWork('Квартира: переносы считаем', 3);
  const first = addDays(today, 3);
  assert.equal((await list(spec, o)).body.moved, null, 'не переносили — строки нет');
  let r = (await ask(spec, o, { new_deadline: addDays(first, 4), reason: 'Жду выписку', from: first })).body;
  await decide(dispatcher, o, r.open.id, { approve: true });
  r = (await ask(spec, o, { new_deadline: addDays(first, 9), reason: 'Ещё неделя' })).body;
  await decide(dispatcher, o, r.open.id, { approve: false });
  r = (await ask(spec, o, { new_deadline: addDays(first, 6), reason: 'Осмотр перенесён' })).body;
  await decide(dispatcher, o, r.open.id, { approve: true });
  r = (await ask(spec, o, { new_deadline: addDays(first, 8), reason: 'Попробую' })).body;
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/deadline-requests/${r.open.id}`)).status, 200);
  const m = (await list(spec, o)).body.moved;
  assert.deepEqual(m, { times: 2, days: 6, first });
  // Видят те же стороны, что и историю; чужой — нет.
  assert.deepEqual((await list(owner, o)).body.moved, m);
  assert.deepEqual((await list(dispatcher, o)).body.moved, m);
  assert.equal((await list(stranger, o)).status, 404);
});

test('готовая фраза заказчику «срок перенесён на …» (2.178): после согласия, пока срок в силе; после отказа — нет', async () => {
  const o = await inWork('Квартира: фраза о переносе', 4);
  const old = addDays(today, 4);
  const want = addDays(today, 11);
  const words = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const phrase = async (c) => (await c.req('GET', `/api/orders/${o.id}/messages`)).body.phrases.find((p) => p.id === 'deadline');
  assert.equal(await phrase(spec), undefined, 'срок не переносили — фразы нет');
  let rid = (await ask(spec, o, { new_deadline: want, reason: 'Жду выписку ЕГРН' })).body.open.id;
  assert.equal(await phrase(spec), undefined, 'пока диспетчер не ответил — фразы нет');
  assert.equal((await decide(dispatcher, o, rid, { approve: true })).status, 200);
  const p = await phrase(spec);
  assert.equal(p.title, 'Срок перенесён');
  assert.equal(p.text, `Здравствуйте! Срок по Вашей заявке перенесён на ${words(want)} (был ${words(old)}). Если появятся вопросы — напишите здесь.`);
  // Заказчику и диспетчеру готовых фраз нет; фраза — только текст, в переписке ничего не появилось.
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}/messages`)).body.phrases, []);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/messages`)).body.messages.length, 0);
  // Новая просьба отклонена — последнее решение «отказ»: фразы о переносе нет.
  rid = (await ask(spec, o, { new_deadline: addDays(today, 20), reason: 'Ещё нужно время' })).body.open.id;
  assert.ok(await phrase(spec), 'пока ждёт ответа — прежний перенос в силе');
  assert.equal((await decide(dispatcher, o, rid, { approve: false })).status, 200);
  assert.equal(await phrase(spec), undefined);
});

test('2.319: срок по заданию на оценку — исполнителю перед просьбой о переносе: кто ждёт отчёт и к какому дню', async () => {
  const o = await inWork('Квартира: перенос и срок по заданию', 6);
  const ruD = (s) => s.split('-').reverse().join('.');
  const put = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': 'basis' } });
  // Задания нет — ничего.
  assert.equal((await list(spec, o)).body.task_due, null);
  const early = addDays(today, 4);
  assert.equal((await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(early)}`, 'Задание.txt')).status, 201);
  assert.deepEqual((await list(spec, o)).body.task_due, { day: early, by: 'по заданию на оценку', who: 'Заказчик', name: 'Задание.txt', page: 1 });
  // Для банка — «Банк ждёт».
  await S.sql`update orders set fields = fields || '{"purpose":"bank"}'::jsonb where id = ${o.id}`;
  assert.equal((await list(spec, o)).body.task_due.who, 'Банк');
  // Заказчик, диспетчер и чужой — не видят.
  assert.equal((await list(owner, o)).body.task_due, null);
  assert.equal((await list(dispatcher, o)).body.task_due, null);
  assert.equal((await list(stranger, o)).status, 404);
  // Предупреждение не запрещает: просьба уходит; пока ждёт ответа — нового предупреждения нет.
  const r = await ask(spec, o, { new_deadline: addDays(today, 12), reason: 'Перенос с заказчиком согласован' });
  assert.equal(r.status, 201);
  assert.equal(r.body.task_due, null);
  assert.equal((await decide(dispatcher, o, r.body.open.id, { approve: false })).status, 200);
  // Определение суда — «Суд ждёт».
  const o2 = await inWork('Квартира: перенос и определение суда', 6);
  assert.equal((await owner.req('POST', `/api/orders/${o2.id}/documents`, Buffer.from(`ОПРЕДЕЛЕНИЕ о назначении судебной экспертизы\nСрок проведения экспертизы: не позднее ${ruD(early)}`), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Определение.txt'), 'x-doc-kind': 'basis' } })).status, 201);
  const t2 = (await list(spec, o2)).body.task_due;
  assert.equal(t2?.who, 'Суд', JSON.stringify(t2));
});

test('2.326: перенос согласован, а новый срок позже срока по заданию — напоминание приложить письмо о переносе', async () => {
  const o = await inWork('Квартира: перенос позже задания', 5);
  const ruD = (s) => s.split('-').reverse().join('.');
  const put = (body, name, kind = 'basis') => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': kind } });
  await S.sql`update orders set fields = fields || '{"purpose":"bank"}'::jsonb where id = ${o.id}`;
  const due = addDays(today, 5);
  assert.equal((await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(due)}`, 'Задание банка.txt')).status, 201);
  // Переноса нет — ничего; просьба ждёт ответа — ничего.
  assert.equal((await list(spec, o)).body.task_moved, null);
  const late = addDays(today, 12);
  const r = await ask(spec, o, { new_deadline: late, reason: 'Банк согласовал перенос устно' });
  assert.equal(r.body.task_moved, null);
  // Отказ — ничего.
  assert.equal((await decide(dispatcher, o, r.body.open.id, { approve: false })).status, 200);
  assert.equal((await list(spec, o)).body.task_moved, null);
  // Согласие — напоминание: новый срок, срок по заданию, кто ждёт и какой документ нужен.
  const r2 = await ask(spec, o, { new_deadline: late, reason: 'Банк согласовал перенос устно' });
  assert.equal((await decide(dispatcher, o, r2.body.open.id, { approve: true })).status, 200);
  const m = (await list(spec, o)).body.task_moved;
  assert.deepEqual({ ...m, asked: m.asked }, { day: due, by: 'по заданию на оценку', who: 'Банк', name: 'Задание банка.txt', page: 1,
    deadline: late, moved_from: addDays(today, 5), doc: 'Письмо банка', asked: null });
  // Заказчик, диспетчер — не видят; чужой — 404.
  assert.equal((await list(owner, o)).body.task_moved, null);
  assert.equal((await list(dispatcher, o)).body.task_moved, null);
  // В «Сегодня» эксперта — строка; согласие отдельной строкой не повторяется.
  let t = (await spec.req('GET', '/api/today')).body.expert;
  const row = t.task_moved.find((x) => x.id === o.id);
  assert.equal(row?.task_moved.day, due);
  assert.equal(row.can_ask, true);
  assert.ok(!t.extend_answer.some((x) => x.id === o.id));
  // Попросить письмо у заказчика: пункт запроса документов с пояснением; заказчик и чужой просить не могут.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true })).status, 403);
  const q = await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  const req = q.body.requests.find((x) => x.item_id === 'task_move');
  assert.equal(req.title, `Письмо банка о переносе срока отчёта на ${ruD(late)}`);
  assert.match(req.note, new RegExp(`перенесён на ${ruD(late)}, а по заданию на оценку отчёт ждут к ${ruD(due)}`));
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true })).status, 409);
  // Ждём письмо — в «Сегодня» строки нет, в «Сроке» — «попросили».
  t = (await spec.req('GET', '/api/today')).body.expert;
  assert.ok(!t.task_moved.some((x) => x.id === o.id));
  assert.ok((await list(spec, o)).body.task_moved.asked.at);
  // Заказчик приложил письмо к пункту с новым сроком — напоминания нет (срок по заданию — из письма).
  const doc = await put(`Уважаемые коллеги! Сообщаем, что срок составления отчёта продлён: не позднее ${ruD(late)}`, 'Скан 001.txt', 'other');
  assert.equal(doc.status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${req.id}/attach`, { document_id: doc.body.document.id })).status, 200);
  assert.equal((await list(spec, o)).body.task_moved, null);
  t = (await spec.req('GET', '/api/today')).body.expert;
  assert.ok(!t.task_moved.some((x) => x.id === o.id));
  // Нет письма, а новый срок — не позже срока по заданию — просить нечего.
  const o2 = await inWork('Квартира: перенос не позже задания', 3);
  assert.equal((await spec.req('POST', `/api/orders/${o2.id}/doc-requests`, { task_move: true })).status, 409);
});
