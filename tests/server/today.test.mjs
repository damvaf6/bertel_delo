// «Сегодня» (2.34): эксперту — что горит по срокам, что вернули на доработку, что на проверке, новые предложения;
// руководителю экспертной организации — то же по делам его экспертов (без данных заказчика), подписи организации,
// возвраты и дела, предложенные организации. Чужие дела и чужие организации не видны.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, spec, head, other, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 77', area: '41' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003401');
  dispatcher = await login(S, '+79990003402');
  spec = await login(S, '+79990003403');
  head = await login(S, '+79990003404');
  other = await login(S, '+79990003405');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  await makeSpecialist(S.sql, other.user.id);
  org = await makeOrg(S.sql, 'ООО «Сегодняшняя оценка»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, spec.user.id, 'member');
  await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Сегодняшний' });
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
});
after(async () => { await S?.close(); });

async function step(c, o, to, reason) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...(reason ? { reason } : {}) });
}
const result = (o, name, who = spec) => who.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`файл ${name}`), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
});

async function offered(title, days, who = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), days), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  return o;
}
const ids = (list) => list.map((x) => x.id);

test('«Сегодня» у эксперта: горит, вернули, на проверке, предложено; у руководителя — дела экспертов без данных заказчика', async () => {
  const fire = await offered('Горящее дело', 1);
  assert.equal((await step(spec, fire, 'in_work')).status, 200);
  const calm = await offered('Спокойное дело', 20);
  assert.equal((await step(spec, calm, 'in_work')).status, 200);
  const offer = await offered('Новое предложение', 9);
  const sent = await offered('Сдано на проверку', 5);
  assert.equal((await step(spec, sent, 'in_work')).status, 200);
  // Диспетчер вернул на доработку с причиной.
  const back = await offered('Вернули на доработку', 6);
  assert.equal((await step(spec, back, 'in_work')).status, 200);
  await S.sql`update orders set status = 'review' where id in (${sent.id}, ${back.id})`;
  assert.equal((await step(dispatcher, back, 'in_work', 'В разделе 3 нет даты осмотра')).status, 200);

  let t = (await spec.req('GET', '/api/today')).body;
  assert.deepEqual(ids(t.expert.hot), [fire.id], 'горит только дело со сроком через день');
  assert.deepEqual(ids(t.expert.offers), [offer.id]);
  assert.ok(t.expert.offers[0].fee_kop > 0);
  assert.deepEqual(ids(t.expert.review), [sent.id]);
  assert.deepEqual(t.expert.returned.map((x) => [x.id, x.by, x.comment]), [[back.id, 'Диспетчер', 'В разделе 3 нет даты осмотра']]);
  assert.deepEqual(t.orgs, [], 'эксперт — не руководитель');

  // Руководитель: подпись организации ждёт, после возврата — «вернул, ждём исправления».
  await head.req('PATCH', '/api/me', { full_name: 'Руководитель Сегодняшний' });
  const d = (await result(fire, 'Отчёт.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  t = (await head.req('GET', '/api/today')).body;
  assert.equal(t.expert, null, 'руководитель — не специалист');
  assert.equal(t.orgs.length, 1);
  const g = t.orgs[0];
  assert.equal(g.name, org.name);
  assert.deepEqual(g.hot.map((x) => [x.expert, x.service, x.overdue]), [['Эксперт Сегодняшний', 'Оценка недвижимости', false]]);
  assert.equal(g.to_sign.length, 1);
  assert.equal(g.to_sign[0].files, 1);
  // «Дела экспертов» (2.102): «горит» — то же, что в «Сегодня»; отбор по подписи — по sign_wait.
  const cs = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases;
  const of = (o) => cs.find((x) => x.id === o.id);
  assert.deepEqual([fire, calm, offer, sent].map((o) => of(o).hot), [true, false, false, false]);
  assert.equal(of(fire).sign_wait, 1);
  const text = JSON.stringify(t);
  for (const secret of ['Горящее дело', 'тестовая ул.', fire.id]) assert.ok(!text.includes(secret), `руководитель не видит: ${secret}`);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: 'Проверьте итог' })).status, 201);
  t = (await head.req('GET', '/api/today')).body;
  assert.equal(t.orgs[0].to_sign.length, 0);
  assert.deepEqual(t.orgs[0].returned.map((x) => x.comment), ['Проверьте итог']);
  // Эксперт видит возврат руководителя.
  const mine = (await spec.req('GET', '/api/today')).body.expert.returned;
  assert.ok(mine.some((x) => x.id === fire.id && x.by === 'Руководитель (Руководитель Сегодняшний)' && x.comment === 'Проверьте итог'));

  // Дело, предложенное организации, — у руководителя «ждут назначения».
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело организации' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 8), fields: FIELDS });
  await step(owner, o, 'matching');
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: org.id, from: 'matching' })).status, 200);
  assert.equal((await head.req('GET', '/api/today')).body.orgs[0].pending.length, 1);
  void calm;
});

test('«Сегодня»: чужие дела и чужие организации не видны; заказчику — пусто', async () => {
  const o = await offered('Дело другого эксперта', 1, other);
  assert.equal((await step(other, o, 'in_work')).status, 200);
  const t = (await spec.req('GET', '/api/today')).body;
  assert.ok(!JSON.stringify(t).includes(o.id), 'дело другого эксперта не видно');
  const mine = (await other.req('GET', '/api/today')).body;
  assert.deepEqual(ids(mine.expert.hot), [o.id]);
  assert.deepEqual(mine.orgs, []);
  const c = (await owner.req('GET', '/api/today')).body;
  assert.deepEqual([c.expert, c.orgs, c.dispatcher], [null, [], null]);
  assert.equal((await spec.req('GET', '/api/today')).body.dispatcher, null, 'раздел диспетчера — только диспетчеру');
  // Сотрудник организации (не руководитель) не получает раздела организации.
  assert.deepEqual((await spec.req('GET', '/api/today')).body.orgs, []);
});

test('«Сегодня» у диспетчера (2.42): назначить цену, подобрать после отказа, молчащий исполнитель, проверка, горит срок, деньги', async () => {
  const draft = async (title, days) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), days), fields: FIELDS })).status, 200);
    assert.equal((await step(owner, o, 'matching')).status, 200);
    return o;
  };
  const noPrice = await draft('Без цены', 10);
  const declined = await offered('Отказ эксперта', 8);
  assert.equal((await step(spec, declined, 'matching', 'Нет времени')).status, 200);
  const silent = await offered('Молчит', 7);
  await S.sql`update order_offers set offered_at = now() - interval '25 hours' where order_id = ${silent.id}`;
  const hot = await offered('Горит у диспетчера', 1);
  assert.equal((await step(spec, hot, 'in_work')).status, 200);
  const rev = await offered('На проверке', 5);
  assert.equal((await step(spec, rev, 'in_work')).status, 200);
  await S.sql`update orders set status = 'review' where id = ${rev.id}`;
  await S.sql`insert into payouts (order_id, executor_user_id, amount_kop, commission_kop, status, failure) values (${rev.id}, ${spec.user.id}, 100, 0, 'failed', 'тест: отклонено')`;

  const d = (await dispatcher.req('GET', '/api/today')).body.dispatcher;
  assert.ok(ids(d.price).includes(noPrice.id));
  const m = d.to_match.find((x) => x.id === declined.id);
  assert.equal(m.reason, 'Нет времени');
  assert.ok(ids(d.slow_offers).includes(silent.id));
  assert.ok(!ids(d.slow_offers).includes(hot.id), 'принятое дело не «молчит»');
  assert.ok(ids(d.hot).includes(hot.id));
  assert.ok(ids(d.review).includes(rev.id));
  const money = d.money.find((x) => x.id === rev.id);
  assert.deepEqual([money.what, money.failure], ['payout', 'тест: отклонено']);
  await S.sql`delete from payouts where order_id = ${rev.id}`;
});

test('«Сегодня» у руководителя (2.98): горит срок, а нет черновика или фото осмотра — отдельно, с тем, чего нет', async () => {
  const bare = await offered('Горит без черновика', 2);
  assert.equal((await step(spec, bare, 'in_work')).status, 200);
  const drafted = await offered('Горит, черновик есть', 1);
  assert.equal((await step(spec, drafted, 'in_work')).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${drafted.id}/draft/ai`, { from: null })).status, 201);
  const far = await offered('Срок далеко, ничего нет', 10);
  assert.equal((await step(spec, far, 'in_work')).status, 200);
  const risk = async () => (await head.req('GET', '/api/today')).body.orgs[0].at_risk;
  let list = await risk();
  const byRef = (o) => list.find((x) => x.order_ref === `№ ${o.id.slice(0, 8).toUpperCase()}`);
  assert.deepEqual(byRef(bare)?.missing, ['нет черновика', 'нет фото осмотра']);
  assert.deepEqual(byRef(drafted)?.missing, ['нет фото осмотра']);
  assert.equal(byRef(far), undefined, 'срок через 10 дней — не горит');
  assert.equal(byRef(bare).expert, 'Эксперт Сегодняшний');
  // Пришло фото осмотра — у дела с черновиком больше ничего не горит.
  await S.sql`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
              values (${drafted.id}, ${spec.user.id}, 'Фото 1.jpg', 'image/jpeg', 10, ${`t/${drafted.id}/1`}, 'inspection')`;
  list = await risk();
  assert.equal(byRef(drafted), undefined);
  assert.ok(byRef(bare));
  // Без данных заказчика и названий заявки; эксперту и чужим — не видно.
  const text = JSON.stringify(list);
  for (const secret of ['Горит без черновика', bare.id]) assert.ok(!text.includes(secret), `руководитель не видит: ${secret}`);
  assert.deepEqual((await spec.req('GET', '/api/today')).body.orgs, []);
  assert.deepEqual((await other.req('GET', '/api/today')).body.orgs, []);
});

test('очередь подписи у эксперта (2.99): подписал, организация ещё нет — сколько ждёт; «Напомнить руководителю» раз в сутки', async () => {
  const o = await offered('Ждёт подписи организации', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const wait = async () => (await spec.req('GET', '/api/today')).body.expert.sign_wait.find((x) => x.id === o.id);
  const remind = () => spec.req('POST', `/api/orders/${o.id}/sign-reminder`);
  const events = async () => (await S.sql`select count(*)::int as n from notifications where user_id = ${head.user.id}
                                          and event = 'org_sign_reminder' and order_id = ${o.id}`)[0].n;
  // Файла нет или он не подписан — ждать нечего, напомнить нельзя.
  assert.equal(await wait(), undefined);
  assert.equal((await remind()).body.error, 'nothing_waiting');
  const d = (await result(o, 'Заключение.pdf')).body.document;
  assert.equal(await wait(), undefined, 'не подписан — не в очереди');
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  let w = await wait();
  assert.equal(w.org, org.name);
  assert.equal(w.files, 1);
  assert.equal(w.reminded_at, null);
  assert.equal(w.can_remind, true);
  assert.ok(w.since);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/documents`)).body.sign_wait.files, 1);
  // Напомнил — руководителю уведомление; второй раз в тот же день нельзя.
  const r = await remind();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sign_wait.can_remind, false);
  assert.ok(r.body.sign_wait.next_remind_at);
  assert.equal(await events(), 1);
  assert.equal((await remind()).body.error, 'too_often');
  assert.equal(await events(), 1);
  w = await wait();
  assert.ok(w.reminded_at);
  assert.equal(w.can_remind, false);
  // Руководитель видит, что эксперт напоминал: в «Сегодня» и в «Подписи организации»; названия заявки — нет.
  const g = (await head.req('GET', '/api/today')).body.orgs[0];
  const ref = `№ ${o.id.slice(0, 8).toUpperCase()}`;
  assert.ok(g.to_sign.find((x) => x.order_ref === ref).reminded_at);
  const signing = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items.find((x) => x.order_ref === ref);
  assert.ok(signing.reminded_at);
  assert.ok(!JSON.stringify(g).includes('Ждёт подписи организации'));
  // Прошли сутки — можно снова.
  await S.sql`update sign_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await wait()).can_remind, true);
  assert.equal((await remind()).status, 201);
  assert.equal(await events(), 2);
  // Организация подписала — очередь пуста, напоминать нечего.
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal(await wait(), undefined);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/documents`)).body.sign_wait, null);
  assert.equal((await remind()).body.error, 'nothing_waiting');
  // Эксперт без организации: очереди подписи организации нет.
  assert.deepEqual((await other.req('GET', '/api/today')).body.expert.sign_wait, []);
});

test('стыки пачки (2.100): руководитель видит просьбу о переносе срока; после возврата прежнее напоминание не в счёт', async () => {
  const o = await offered('Стыки пачки', 1);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const ref = `№ ${o.id.slice(0, 8).toUpperCase()}`;
  const want = addDays(todayMsk(), 9);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: want, reason: 'Заказчик не пускает на осмотр' })).status, 201);
  // Эксперт — в «Горит срок», руководитель — в «Горит» и в «Делах экспертов»: новая дата, причины нет.
  assert.equal((await spec.req('GET', '/api/today')).body.expert.hot.find((x) => x.id === o.id).extend.new_deadline, want);
  const g = (await head.req('GET', '/api/today')).body.orgs[0];
  assert.equal(g.at_risk.find((x) => x.order_ref === ref).extend.new_deadline, want);
  assert.ok(!JSON.stringify(g).includes('не пускает'));
  const cases = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases;
  assert.equal(cases.find((x) => x.order_ref === ref).extend.new_deadline, want);
  assert.ok(!JSON.stringify(cases).includes('не пускает'));
  // Подписал, напомнил; руководитель вернул — напоминание к возврату не тянется.
  const d = (await result(o, 'Стыки.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/sign-reminder`)).status, 201);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: '1. Нет даты осмотра' })).status, 201);
  const signing = async () => (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items.find((x) => x.order_ref === ref);
  assert.equal((await signing()).reminded_at, null);
  // Подписал заново — новое ожидание: можно напомнить сразу, у руководителя «напомнил» пока нет.
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  const w = (await spec.req('GET', '/api/today')).body.expert.sign_wait.find((x) => x.id === o.id);
  assert.equal(w.reminded_at, null);
  assert.equal(w.can_remind, true);
  assert.equal((await head.req('GET', '/api/today')).body.orgs[0].to_sign.find((x) => x.order_ref === ref).reminded_at, null);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/sign-reminder`)).status, 201);
  assert.ok((await signing()).reminded_at);
});
