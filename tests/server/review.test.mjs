// Отзыв заказчика (2.467, схема 5 экранов — решение Дамира 31.10/02.11.2026, экран 5): после выдачи заказчик ставит оценку
// 1–5 и пишет пару слов. Видят диспетчер и руководитель организации эксперта (ЦНЭР); эксперту и посторонним — нет.
// От трёх отзывов средняя оценка входит в «качество» подбора.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { scoreSpecialist } from '../../src/matching/score.mjs';

let S, owner, dispatcher, expert, head, other, stranger, org;

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004671');
  dispatcher = await login(S, '+79990004672');
  expert = await login(S, '+79990004673');
  head = await login(S, '+79990004674');
  other = await login(S, '+79990004675');
  stranger = await login(S, '+79990004676');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, expert.user.id);
  await makeSpecialist(S.sql, other.user.id);
  org = await makeOrg(S.sql, 'ООО «ЦНЭР-Отзыв»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, expert.user.id, 'member');
  assert.equal((await expert.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
});
after(async () => { await S?.close(); });

// Эксперт взял дело из ленты; статус выдачи ставим напрямую — путь до «готово» проверяют свои тесты.
async function issued(title, status = 'done') {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Отзывная ул., 1' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: addDays(todayMsk(), 10) })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id, 1_200_000);
  assert.equal((await expert.req('POST', `/api/specialist/feed/${o.id}/take`)).status, 200);
  if (status !== 'in_work') await S.sql`update orders set status = ${status} where id = ${o.id}`;
  return o;
}
const view = async (c, id) => (await c.req('GET', `/api/orders/${id}`)).body;
const review = (c, id, body) => c.req('POST', `/api/orders/${id}/review`, body);
const card = async (c, id) => c.req('GET', `/api/specialists/${id}/card`);

test('отзыв есть у «Экспертизы», у переводов — нет', () => {
  const reg = createRegistry();
  assert.equal(reg.review('expertise'), true);
  assert.equal(reg.review('translation'), false);
});

test('до выдачи отзыв оставить нельзя; после — только заказчик, оценка 1–5, один раз', async () => {
  const w = await issued('Отзыв: в работе', 'in_work');
  assert.equal((await view(owner, w.id)).review, null, 'пока в работе — блока нет');
  assert.equal((await review(owner, w.id, { rating: 5 })).status, 409);

  const o = await issued('Отзыв: выдано');
  assert.deepEqual((await view(owner, o.id)).review, { mine: true, rating: null, text: null, at: null, can_review: true });
  assert.equal((await review(stranger, o.id, { rating: 5 })).status, 404, 'чужой — заявки не видно');
  assert.equal((await review(expert, o.id, { rating: 5 })).status, 403, 'эксперт сам себе не ставит');
  assert.equal((await review(dispatcher, o.id, { rating: 5 })).status, 403, 'диспетчер за заказчика не ставит');
  for (const bad of [0, 6, 4.5, '5', null]) assert.equal((await review(owner, o.id, { rating: bad })).status, 400, `оценка ${bad}`);
  assert.equal((await review(owner, o.id, { rating: 4, text: 'я'.repeat(501) })).status, 400, 'длиннее 500 знаков');

  const r = await review(owner, o.id, { rating: 4, text: '  Всё понятно, чуть позже срока.  ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'Всё понятно, чуть позже срока.');
  assert.equal((await review(owner, o.id, { rating: 5 })).status, 409, 'второй раз нельзя');
  const mine = (await view(owner, o.id)).review;
  assert.equal(mine.rating, 4);
  assert.equal(mine.can_review, false);

  // Диспетчер видит, эксперт — нет (ответ эксперта — позже, по схеме).
  const d = (await view(dispatcher, o.id)).review;
  assert.equal(d.rating, 4);
  assert.equal(d.text, 'Всё понятно, чуть позже срока.');
  assert.equal(d.can_review, false);
  assert.equal(d.mine, false);
  assert.equal((await view(expert, o.id)).review, null);
  const [log] = await S.sql`select details from audit_log where action = 'order.review' and subject_id = ${o.id}`;
  assert.equal(log.details.rating, 4);
});

test('после закрытия заявки отзыв тоже можно оставить; диспетчер без отзыва видит «нет оценки»', async () => {
  const o = await issued('Отзыв: закрыта', 'closed');
  assert.deepEqual((await view(dispatcher, o.id)).review, { mine: false, rating: null, text: null, at: null, can_review: false });
  assert.equal((await review(owner, o.id, { rating: 2, text: 'Долго' })).status, 200);
});

test('карточка эксперта: отзывы видят диспетчер и руководитель его организации; сам эксперт и чужой руководитель — нет', async () => {
  const o = await issued('Отзыв: карточка');
  assert.equal((await review(owner, o.id, { rating: 5, text: 'Отлично' })).status, 200);
  for (const c of [dispatcher, head]) {
    const r = await card(c, expert.user.id);
    assert.equal(r.status, 200);
    assert.ok(r.body.reviews.n >= 3);
    assert.equal(r.body.reviews.last[0].text, 'Отлично');
    assert.equal(r.body.reviews.last[0].rating, 5);
    assert.match(r.body.reviews.last[0].order_ref, /^№/);
    assert.match(r.body.quality.note, /оценка заказчиков 3,7 из 5 \(отзывов: 3\)/);
  }
  const self = (await card(expert, expert.user.id)).body;
  assert.equal(self.reviews, null);
  assert.ok(!('rating_avg' in self.stats));
  assert.doesNotMatch(self.quality.note, /оценка заказчиков/);
  assert.equal((await card(other, expert.user.id)).status, 404, 'другой эксперт карточку не видит');
});

test('подбор: средняя оценка от трёх отзывов входит в «качество»; меньше — не учитывается', () => {
  const spec = { regions: ['moscow'], capacity: 5, external_load: 0 };
  const order = { fields: { region: 'moscow' } };
  const q = (stats) => scoreSpecialist(spec, { open: 0, offers: 0, accepted: 0, ...stats }, order, null).features.quality;
  assert.equal(q({ rating_n: 2, rating_avg: 1 }).score, 70, 'двух отзывов мало — нейтрально');
  assert.equal(q({ rating_n: 3, rating_avg: 5 }).score, 100);
  assert.equal(q({ rating_n: 3, rating_avg: 1 }).score, 0);
  assert.equal(q({ rating_n: 4, rating_avg: 4.5 }).note, 'оценка заказчиков 4,5 из 5 (отзывов: 4)');
  // Вместе с прочими признаками — среднее.
  assert.equal(q({ rating_n: 3, rating_avg: 3, done: 4, on_time: 4, returned: 0 }).score, Math.round((100 + 100 + 50) / 3));
});
