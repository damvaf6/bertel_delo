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
