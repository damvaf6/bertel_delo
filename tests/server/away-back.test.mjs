// 2.239: эксперт вернулся после дней «не принимаю дела» — в первый день после 8:00 по Москве одно уведомление, что произошло
// с его делами (передачи, решения по срокам, новые сообщения, пришедшие документы); подробно — «Пока Вас не было».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { sendAwayBack } from '../../src/notify/away.mjs';

let S, owner, dispatcher, spec, colleague, head;
const T = todayMsk();
// 9:00 по Москве сегодня — после утреннего часа; 7:00 — до него.
const at9 = new Date(`${T}T09:00:00+03:00`);
const at7 = new Date(`${T}T07:00:00+03:00`);
before(async () => {
  S = await startApp();
  owner = await login(S, '+79990002391');
  dispatcher = await login(S, '+79990002392');
  spec = await login(S, '+79990002393');
  colleague = await login(S, '+79990002394');
  head = await login(S, '+79990002395');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  for (const u of [spec, colleague]) await makeSpecialist(S.sql, u.user.id);
});
after(async () => { await S?.close(); });

// Момент n дней назад в полдень по Москве.
const ago = (n) => new Date(`${addDays(T, -n)}T12:00:00+03:00`);
async function order(title, executor = spec.user.id) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  await S.sql`update orders set status = 'in_work', executor_user_id = ${executor}, deadline = ${addDays(T, 10)}::date where id = ${o.id}`;
  return o;
}
const backs = () => S.sql`select n.id, n.event, d.body from notifications n left join notification_deliveries d on d.notification_id = n.id
                          where n.user_id = ${spec.user.id} and n.event = 'away_back' order by n.id`;
const getBack = async () => { const r = await spec.req('GET', '/api/specialist/me/back'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.back; };

test('2.239: отметка «с сегодня» помнит первый день; продлил идущие дни — первый день прежний', async () => {
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { away: { until: addDays(T, 5) } })).status, 200);
  const day = async () => (await S.sql.one`select to_char(away_since, 'YYYY-MM-DD') as d from specialists where user_id = ${spec.user.id}`).d;
  assert.equal(await day(), T);
  await S.sql`update specialists set away_since = ${addDays(T, -3)}::date where user_id = ${spec.user.id}`;
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { away: { until: addDays(T, 8), note: 'отпуск' } })).status, 200);
  assert.equal(await day(), addDays(T, -3), 'продлил — считаем с прежнего первого дня');
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { away: { from: addDays(T, 2), until: addDays(T, 8) } })).status, 200);
  assert.equal(await day(), addDays(T, 2), 'с заданного дня');
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { away: null })).status, 200);
  assert.equal(await day(), null);
});

test('2.239: в первый день — одно уведомление: передачи, сроки, сообщения, документы; до и после дней — не в счёт', async () => {
  const kept = await order('Пока не было: срок и сообщения');
  const given = await order('Пока не было: передано Вам', colleague.user.id);
  const taken = await order('Пока не было: передано коллеге');
  const quiet = await order('Пока не было: тихое дело');
  // Дни «не принимаю»: с 7 дней назад по вчера, сегодня — снова принимает.
  await S.sql`update specialists set away_since = ${addDays(T, -7)}::date, away_from = ${addDays(T, -7)}::date, away_until = ${T}::date,
                away_back_for = null where user_id = ${spec.user.id}`;
  // Передачи руководителем организации (как orgs.cases.transfer).
  await S.sql`update orders set executor_user_id = ${spec.user.id} where id = ${given.id}`;
  await S.sql`insert into audit_log (actor_id, action, subject_type, subject_id, details, at) values
    (${head.user.id}, 'org.case.transfer', 'order', ${given.id}, ${{ from: colleague.user.id, to: spec.user.id }}, ${ago(3)}),
    (${head.user.id}, 'org.case.transfer', 'order', ${taken.id}, ${{ from: spec.user.id, to: colleague.user.id }}, ${ago(2)})`;
  await S.sql`update orders set executor_user_id = ${colleague.user.id} where id = ${taken.id}`;
  // Сроки: отказ диспетчера в дни отсутствия, согласие — до них (не в счёт).
  await S.sql`insert into deadline_requests (order_id, requested_by, old_deadline, new_deadline, reason, requested_at, outcome, decided_by, decided_at, answer) values
    (${kept.id}, ${spec.user.id}, ${addDays(T, 10)}::date, ${addDays(T, 15)}::date, 'меня не будет', ${ago(8)}, 'declined', ${dispatcher.user.id}, ${ago(4)}, 'Заказчику срочно'),
    (${quiet.id}, ${spec.user.id}, ${addDays(T, 10)}::date, ${addDays(T, 12)}::date, 'загрузка', ${ago(10)}, 'approved', ${dispatcher.user.id}, ${ago(9)}, null)`;
  // Сообщения: два от заказчика и одно от руководителя в эти дни; своё и до дней — не в счёт.
  await S.sql`insert into order_messages (order_id, author_id, side, body, at) values
    (${kept.id}, ${owner.user.id}, 'customer', 'Вопрос 1', ${ago(5)}), (${kept.id}, ${owner.user.id}, 'customer', 'Вопрос 2', ${ago(1)}),
    (${kept.id}, ${spec.user.id}, 'executor', 'Мой ответ', ${ago(1)}), (${quiet.id}, ${owner.user.id}, 'customer', 'Давно', ${ago(9)})`;
  // Документ, запрошенный до отпуска, пришёл в эти дни.
  await S.sql`insert into doc_requests (order_id, title, requested_by, requested_at, fulfilled_at) values
    (${kept.id}, 'Выписка ЕГРН', ${spec.user.id}, ${ago(9)}, ${ago(2)})`;

  assert.equal(await sendAwayBack(S.sql, { now: at7 }), 0, 'до 8:00 — не отправляем');
  assert.equal((await backs()).length, 0);
  assert.equal(await sendAwayBack(S.sql, { now: at9 }), 1);
  assert.equal(await sendAwayBack(S.sql, { now: at9 }), 0, 'второй раз — нет');
  const [n] = await backs();
  assert.equal(n.body, 'БЕРТЕЛ Дело: пока Вас не было — передали коллегам: 1, передали Вам: 1, решения по срокам: 1, '
    + 'дела с новыми сообщениями: 1, пришли документы: 1. Подробно — «Пока Вас не было» в кабинете.');
  assert.ok(!n.body.includes('Пока не было:'), 'в СМС нет названий дел');

  const b = await getBack();
  assert.equal(b.from, addDays(T, -7));
  assert.equal(b.until, T);
  assert.equal(b.taken, 1);
  assert.deepEqual(b.given.map((g) => g.order_id), [given.id]);
  assert.equal(b.deadlines.length, 1);
  assert.equal(b.deadlines[0].order_id, kept.id);
  assert.equal(b.deadlines[0].outcome, 'declined');
  assert.equal(b.deadlines[0].answer, 'Заказчику срочно');
  assert.deepEqual(b.messages.map((m) => [m.order_id, m.chat, m.head]), [[kept.id, 2, 0]]);
  assert.deepEqual(b.docs.map((d) => [d.order_id, d.n]), [[kept.id, 1]]);
  assert.ok(![...b.given, ...b.deadlines, ...b.messages, ...b.docs].some((x) => x.order_id === taken.id), 'забранное дело — только числом');

  // Неделю видно; позже — нет.
  await S.sql`update specialists set away_until = ${addDays(T, -6)}::date, away_since = ${addDays(T, -13)}::date where user_id = ${spec.user.id}`;
  assert.ok(await getBack());
  await S.sql`update specialists set away_until = ${addDays(T, -7)}::date where user_id = ${spec.user.id}`;
  assert.equal(await getBack(), null);
  for (const o of [kept, given, taken, quiet]) await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
});

test('2.256: документы пришли после ИИ-проверки — «проверьте заново»; до проверки или проверил заново — просто «пришли»', async () => {
  const late = await order('Пока не было: документ после проверки');
  const early = await order('Пока не было: документ до проверки');
  await S.sql`update specialists set away_since = ${addDays(T, -7)}::date, away_from = ${addDays(T, -7)}::date, away_until = ${T}::date,
                away_back_for = null where user_id = ${spec.user.id}`;
  const doc = async (o, name) => (await S.sql`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
    values (${o.id}, ${owner.user.id}, ${name}, 'application/pdf', 10, ${`back-${o.id}-${name}`}, 'other') returning id`)[0].id;
  const review = (o, at) => S.sql`insert into ai_reviews (order_id, round, requested_by, side, model, items, files, at)
    values (${o.id}, 1, ${spec.user.id}, 'executor', 'fake', '[]', '[]', ${at})`;
  // ИИ-проверка до отпуска; выписка ЕГРН пришла в отпуске — после проверки.
  await review(late, ago(9));
  await S.sql`insert into doc_requests (order_id, item_id, title, requested_by, requested_at, fulfilled_at, document_id) values
    (${late.id}, 'egrn', 'Выписка ЕГРН', ${spec.user.id}, ${ago(10)}, ${ago(3)}, ${await doc(late, 'egrn.pdf')})`;
  // Техпаспорт пришёл в отпуске, а ИИ-проверка — уже после него.
  await S.sql`insert into doc_requests (order_id, title, requested_by, requested_at, fulfilled_at, document_id) values
    (${early.id}, 'Техпаспорт', ${spec.user.id}, ${ago(10)}, ${ago(4)}, ${await doc(early, 'bti.pdf')})`;
  await review(early, ago(2));

  assert.equal(await sendAwayBack(S.sql, { now: at9 }), 1);
  const [n] = (await backs()).slice(-1);
  // «передали коллегам» — от прошлого теста (то же окно дней); здесь важен хвост.
  assert.match(n.body, /пришли документы: 2, проверьте заново ИИ-проверку: 1\. Подробно — «Пока Вас не было» в кабинете\.$/);
  const ofs = async () => { const b = await getBack(); return [late, early].map((o) => b.docs.find((d) => d.order_id === o.id)); };
  let [dl, de] = await ofs();
  assert.deepEqual([dl.n, dl.recheck.docs, de.n, de.recheck], [1, ['Выписка ЕГРН'], 1, undefined]);
  assert.equal(dl.recheck.egrn, true);
  assert.ok(!('status' in dl) && !('review_round' in dl));

  // Проверил заново после возвращения — строка снова просто «пришли документы».
  await review(late, ago(0));
  [dl, de] = await ofs();
  assert.deepEqual([dl.recheck, de.recheck], [undefined, undefined]);
  // Дело сдано на проверку — ИИ-проверка этого круга закрыта, «проверьте заново» нет.
  await S.sql`delete from ai_reviews where order_id = ${late.id} and at > ${ago(1)}`;
  assert.ok((await ofs())[0].recheck);
  await S.sql`update orders set status = 'review' where id = ${late.id}`;
  assert.equal((await ofs())[0].recheck, undefined);
  for (const o of [late, early]) await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
});

test('2.239: ничего не произошло — не беспокоим; дни ещё идут — не отправляем', async () => {
  await S.sql`delete from notification_deliveries where notification_id in (select id from notifications where user_id = ${spec.user.id} and event = 'away_back')`;
  await S.sql`delete from notifications where user_id = ${spec.user.id} and event = 'away_back'`;
  // Вчера — один день «не принимаю»: передача из прошлого теста (2 дня назад) — не в эти дни.
  await S.sql`update specialists set away_since = ${addDays(T, -1)}::date, away_from = null, away_until = ${addDays(T, 1)}::date,
                away_back_for = null where user_id = ${spec.user.id}`;
  assert.equal(await sendAwayBack(S.sql, { now: at9 }), 0, 'ещё не вернулся');
  await S.sql`update specialists set away_until = ${T}::date where user_id = ${spec.user.id}`;
  assert.equal(await sendAwayBack(S.sql, { now: at9 }), 0, 'с делами ничего не было');
  assert.equal((await backs()).length, 0);
  assert.equal((await S.sql.one`select to_char(away_back_for, 'YYYY-MM-DD') as d from specialists where user_id = ${spec.user.id}`).d, T,
    'отметили — не проверяем каждую минуту');
  assert.equal(await getBack(), null, 'блока нет');
});

test('2.244: «Всё посмотрел» убирает блок до следующих дней «не принимаю дела»; дни изменились — «уже изменилось»', async () => {
  const o = await order('Посмотрел: дело с сообщением');
  await S.sql`update specialists set away_since = ${addDays(T, -4)}::date, away_from = null, away_until = ${addDays(T, -1)}::date,
                away_back_for = null, away_back_seen = null where user_id = ${spec.user.id}`;
  await S.sql`insert into order_messages (order_id, author_id, side, body, at) values (${o.id}, ${owner.user.id}, 'customer', 'Вы где?', ${ago(2)})`;
  const b = await getBack();
  assert.equal(b.until, addDays(T, -1));
  const seen = (until) => spec.req('POST', '/api/specialist/me/back/seen', { until });
  assert.equal((await seen('вчера')).status, 400);
  const stale = await seen(addDays(T, -2));
  assert.equal(stale.status, 409, 'видел другие дни');
  assert.ok(await getBack(), 'блок на месте');
  assert.equal((await seen(b.until)).status, 200);
  assert.equal(await getBack(), null, 'блок убран');
  // Не специалист — тоже «уже изменилось», чужая отметка не трогается.
  assert.equal((await owner.req('POST', '/api/specialist/me/back/seen', { until: b.until })).status, 409);
  // Новые дни «не принимаю» закончились — блок снова виден.
  await S.sql`update specialists set away_since = ${addDays(T, -3)}::date, away_until = ${T}::date where user_id = ${spec.user.id}`;
  assert.equal((await getBack()).until, T);
  await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
});
