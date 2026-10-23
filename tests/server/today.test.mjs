// «Сегодня» (2.34): эксперту — что горит по срокам, что вернули на доработку, что на проверке, новые предложения;
// руководителю экспертной организации — то же по делам его экспертов (без данных заказчика), подписи организации,
// возвраты и дела, предложенные организации. Чужие дела и чужие организации не видны.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember , docsAskedAgo } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { customerSilent, workingAgo } from '../../src/orders/silence.mjs';

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
  // Когда вернули и куда вести (2.147): после диспетчера — к файлу результата.
  assert.equal(t.expert.returned[0].to, 'result');
  assert.ok(Date.now() - Date.parse(t.expert.returned[0].at) < 60_000, 'время возврата — из истории статусов');
  assert.equal(t.expert.returned[0].points, undefined, 'у возврата диспетчера пунктов нет');
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
  // 2.160: когда эксперт подписал — как в «Делах экспертов».
  assert.ok(Date.now() - Date.parse(g.to_sign[0].since) < 60_000);
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
  // 2.160: сколько пунктов замечания эксперт уже отметил — как в «Делах экспертов».
  assert.deepEqual([t.orgs[0].returned[0].points, t.orgs[0].returned[0].left], [1, 1]);
  // Эксперт видит возврат руководителя.
  const mine = (await spec.req('GET', '/api/today')).body.expert.returned;
  assert.ok(mine.some((x) => x.id === fire.id && x.by === 'Руководитель (Руководитель Сегодняшний)' && x.comment === 'Проверьте итог'));
  // 2.147: возврат руководителя — к замечаниям по пунктам, сколько не исправлено; ближе срок — выше (срок через день раньше, чем через 6).
  const fromHead = mine.find((x) => x.id === fire.id);
  assert.deepEqual([fromHead.to, fromHead.points, fromHead.left], ['fix', 1, 1]);
  assert.ok(fromHead.at);
  assert.deepEqual(ids(mine), [fire.id, back.id], 'ближе срок — выше');

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
  assert.equal(w.long, false, 'только что подписал — не «Руководитель ещё не подписал»');
  // 2.152: ждёт 2 дня и дольше — отметка long (строка «Руководитель ещё не подписал»); чуть меньше — ещё нет.
  await S.sql`update document_signatures set signed_at = now() - interval '47 hours' where document_id = ${d.id}`;
  assert.equal((await wait()).long, false);
  await S.sql`update document_signatures set signed_at = now() - interval '49 hours' where document_id = ${d.id}`;
  assert.equal((await wait()).long, true);
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
  // 2.148: с какого времени ждёт подписи — в «Подписи организации» и в «Делах экспертов», вместе с напоминанием.
  assert.equal(new Date(signing.waiting_since).getTime(), new Date(w.since).getTime());
  const kase = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((x) => x.id === o.id);
  assert.equal(kase.sign_wait, 1);
  assert.equal(new Date(kase.sign_since).getTime(), new Date(w.since).getTime());
  assert.equal(new Date(kase.sign_reminded_at).getTime(), new Date(w.reminded_at).getTime());
  // Прошли сутки — можно снова.
  await S.sql`update sign_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await wait()).can_remind, true);
  assert.equal((await remind()).status, 201);
  assert.equal(await events(), 2);
  // Организация подписала — очередь пуста, напоминать нечего.
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal(await wait(), undefined);
  const signed = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((x) => x.id === o.id);
  assert.deepEqual([signed.sign_wait, signed.sign_since, signed.sign_reminded_at], [0, null, null]);
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

test('эксперт не принимает дела (2.113): руководителю в «Сегодня» — его дела со сроком в эти дни, в «Делах экспертов» передать', async () => {
  const inside = await offered('Срок в отпуске', 3);
  assert.equal((await step(spec, inside, 'in_work')).status, 200);
  const after = await offered('Срок после отпуска', 12);
  assert.equal((await step(spec, after, 'in_work')).status, 200);
  const asked = await offered('Сам просит передать', 4);
  assert.equal((await step(spec, asked, 'in_work')).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${asked.id}/handover`, { reason: 'Отпуск' })).status, 201);
  const ref = (o) => `№ ${o.id.slice(0, 8).toUpperCase()}`;
  const away = async () => (await head.req('GET', '/api/today')).body.orgs[0].away;
  assert.deepEqual(await away(), [], 'отметки нет — и списка нет');
  const until = addDays(todayMsk(), 10);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { away: { until, note: 'отпуск' } })).status, 200);
  // В файле есть и другие дела эксперта в работе — смотрим на свои три.
  const list = (await away()).filter((x) => [inside, after, asked].map(ref).includes(x.order_ref));
  assert.deepEqual(list.map((x) => x.order_ref), [ref(inside)], 'срок после возвращения и уже просит передать — не здесь');
  assert.equal(list[0].away_until, until);
  assert.equal(list[0].away_note, 'отпуск');
  assert.equal(list[0].expert, 'Эксперт Сегодняшний');
  // Передать есть кому или нет (прогон 2.210) — «передайте коллеге» в «Сегодня» только если есть.
  assert.equal(typeof list[0].can_transfer, 'boolean');
  const text = JSON.stringify(list);
  for (const secret of ['Срок в отпуске', inside.id]) assert.ok(!text.includes(secret), `руководитель не видит: ${secret}`);
  // В «Делах экспертов» у дела — отметка, передать есть кому не обязательно; у дела после отпуска — нет.
  const cases = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases;
  assert.deepEqual(cases.find((c) => c.id === inside.id).away, { from: null, until, note: 'отпуск' });
  assert.equal(cases.find((c) => c.id === after.id).away, null);
  // Эксперту и чужим — не видно; отметку сняли — список пуст.
  assert.deepEqual((await spec.req('GET', '/api/today')).body.orgs, []);
  assert.deepEqual((await other.req('GET', '/api/today')).body.orgs, []);
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { away: null })).status, 200);
  assert.deepEqual(await away(), []);
});

test('заказчик ждёт ответа больше суток (2.132): без ответа эксперта — даже прочитанное; ответил — пропало; диспетчер не в счёт', async () => {
  const o = await offered('Дело с вопросом заказчика', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const say = (c, body) => c.req('POST', `/api/orders/${o.id}/messages`, { body });
  const waits = async (c = spec) => (await c.req('GET', '/api/today')).body.expert?.reply_wait ?? [];
  assert.equal((await say(owner, 'Когда будет готово?')).status, 201);
  assert.deepEqual(await waits(), [], 'меньше суток — не горит');
  await S.sql`update order_messages set at = now() - interval '26 hours' where order_id = ${o.id}`;
  assert.equal((await say(owner, 'Ответьте, пожалуйста')).status, 201);
  // Эксперт открыл дело — сообщение прочитано, но ответа нет: строка остаётся.
  assert.equal((await spec.req('GET', `/api/orders/${o.id}`)).status, 200);
  let w = await waits();
  assert.deepEqual(w.map((x) => [x.id, x.count, x.last]), [[o.id, 2, 'Ответьте, пожалуйста']]);
  assert.ok(Date.now() - Date.parse(w[0].since) > 25 * 3600_000, 'ждёт с первого сообщения без ответа');
  assert.deepEqual(await waits(other), [], 'чужой эксперт не видит');
  // Ответил диспетчер — заказчик всё ещё ждёт эксперта.
  assert.equal((await say(dispatcher, 'Передадим эксперту')).status, 201);
  assert.equal((await waits()).length, 1);
  // Эксперт ответил — строки нет; новое сообщение заказчика снова ждёт сутки.
  assert.equal((await say(spec, 'Завтра к вечеру')).status, 201);
  assert.deepEqual(await waits(), []);
  assert.equal((await say(owner, 'Спасибо')).status, 201);
  assert.deepEqual(await waits(), []);
  await S.sql`update order_messages set at = now() - interval '25 hours' where order_id = ${o.id} and body = 'Спасибо'`;
  w = await waits();
  assert.deepEqual(w.map((x) => [x.count, x.last]), [[1, 'Спасибо']]);
});

test('«Можно продолжать» и «Заказчик ждёт ответа» не повторяют одно дело (2.140)', async () => {
  const o = await offered('Дело, не открытое экспертом', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  await S.sql`delete from order_seen where order_id = ${o.id}`;
  const today = async () => (await spec.req('GET', '/api/today')).body.expert;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/messages`, { body: 'Есть новости?' })).status, 201);
  // Меньше суток — сообщение в «Можно продолжать».
  let t = await today();
  assert.deepEqual(t.ready.find((x) => x.id === o.id)?.what, ['сообщений: 1']);
  assert.ok(!ids(t.reply_wait).includes(o.id));
  // Больше суток — только в «Заказчик ждёт ответа».
  await S.sql`update order_messages set at = now() - interval '26 hours' where order_id = ${o.id}`;
  t = await today();
  assert.ok(ids(t.reply_wait).includes(o.id));
  assert.ok(!ids(t.ready).includes(o.id), 'одни сообщения — в «Можно продолжать» строки нет');
  assert.ok(t.ready.every((x) => !('other' in x)), 'служебное поле наружу не уходит');
});

test('Срок близко, а файла результата нет (2.138): строка в «Сегодня» и предупреждение в деле — только исполнителю', async () => {
  const bare = await offered('Без файла, срок завтра', 1, other);
  assert.equal((await step(other, bare, 'in_work')).status, 200);
  const late = await offered('Без файла, просрочено', 3, other);
  assert.equal((await step(other, late, 'in_work')).status, 200);
  await S.sql`update orders set deadline = ${addDays(todayMsk(), -1)} where id = ${late.id}`;
  const far = await offered('Без файла, срок далеко', 10, other);
  assert.equal((await step(other, far, 'in_work')).status, 200);
  const done = await offered('С файлом, срок завтра', 1, other);
  assert.equal((await step(other, done, 'in_work')).status, 200);
  assert.equal((await result(done, 'Отчёт готов.pdf', other)).status, 201);
  await S.sql`insert into result_drafts (order_id, author_id, source, body) values (${late.id}, ${other.user.id}, 'edit', 'Черновик')`;

  const t = (await other.req('GET', '/api/today')).body.expert;
  const mine = new Set([bare.id, late.id, far.id, done.id]); // у этого эксперта есть дела из прежних проверок
  assert.deepEqual(ids(t.no_result).filter((x) => mine.has(x)).sort(), [bare.id, late.id].sort(), 'только дела в работе со сроком ≤ 2 дней и без своего файла');
  assert.equal(t.no_result.find((x) => x.id === late.id).overdue, true);
  assert.equal(t.no_result.find((x) => x.id === late.id).has_draft, true);
  assert.equal(t.no_result.find((x) => x.id === bare.id).has_draft, false);
  assert.ok(ids(t.hot).includes(done.id), 'с файлом — остаётся в «Горит срок»');

  const due = (o, who = other) => who.req('GET', `/api/orders/${o.id}/documents`).then((r) => r.body.result_due);
  assert.deepEqual(await due(bare), { deadline: addDays(todayMsk(), 1), days_left: 1, overdue: false, has_draft: false });
  assert.deepEqual(await due(late), { deadline: addDays(todayMsk(), -1), days_left: -1, overdue: true, has_draft: true });
  assert.equal(await due(far), null, 'срок далеко — без предупреждения');
  assert.equal(await due(done), null, 'файл есть — без предупреждения');
  // Заказчик предупреждения не получает.
  assert.equal(await due(bare, owner), undefined);
  // Файл загружен — предупреждение и строка пропадают.
  assert.equal((await result(bare, 'Отчёт.pdf', other)).status, 201);
  assert.equal(await due(bare), null);
  assert.ok(!ids((await other.req('GET', '/api/today')).body.expert.no_result).includes(bare.id));
});

test('«Ждут подписи организации» у руководителя (2.161): дольше всех ждущие — первыми, 2 дня и дольше — отметка long', async () => {
  const signed = async (title, hours) => {
    const o = await offered(title, 12);
    assert.equal((await step(spec, o, 'in_work')).status, 200);
    const d = (await result(o, `${title}.pdf`)).body.document;
    assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
    await S.sql`update document_signatures set signed_at = now() - make_interval(hours => ${hours}) where document_id = ${d.id}`;
    return { o, d, ref: `№ ${o.id.slice(0, 8).toUpperCase()}` };
  };
  const fresh = await signed('Свежая подпись', 1);
  const old = await signed('Давняя подпись', 72);
  const mid = await signed('Почти два дня', 47);
  const g = (await head.req('GET', '/api/today')).body.orgs[0];
  const mine = g.to_sign.filter((x) => [fresh, old, mid].some((c) => c.ref === x.order_ref));
  assert.deepEqual(mine.map((x) => x.order_ref), [old.ref, mid.ref, fresh.ref]);
  assert.deepEqual(mine.map((x) => x.long), [true, false, false]);
  // Руководитель подписал — дела больше нет в очереди.
  for (const c of [fresh, old, mid]) assert.equal((await head.req('POST', `/api/org-documents/${c.d.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await head.req('GET', '/api/today')).body.orgs[0].to_sign.filter((x) => [fresh, old, mid].some((c) => c.ref === x.order_ref)).length, 0);
});

test('«Вернули эксперту» у руководителя (2.162): «Напомнить эксперту» прямо в «Сегодня», раз в сутки', async () => {
  const o = await offered('Напомнить из Сегодня', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const d = (await result(o, 'Напомнить.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: 'Поправьте раздел 4' })).status, 201);
  const ref = `№ ${o.id.slice(0, 8).toUpperCase()}`;
  const row = async () => (await head.req('GET', '/api/today')).body.orgs[0].returned.find((x) => x.order_ref === ref);
  let x = await row();
  assert.deepEqual([x.remind.can_remind, x.remind.reminded_at], [true, null]);
  assert.ok(!JSON.stringify(x).includes(o.id), 'полного номера дела в «Сегодня» нет');
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/remind`)).status, 201);
  x = await row();
  assert.equal(x.remind.can_remind, false, 'снова — только через сутки');
  assert.ok(Date.now() - Date.parse(x.remind.reminded_at) < 60_000);
  assert.equal(x.remind.reminders, 1);
  // Сутки прошли — снова можно.
  await S.sql`update case_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await row()).remind.can_remind, true);
  // Эксперт своей «кнопки» не видит: у него в «Сегодня» руководительской части нет.
  assert.deepEqual((await spec.req('GET', '/api/today')).body.orgs, []);
});

test('возвращённый файл удалён, исправленный загружен (2.170): в «Сегодня» эксперта и руководителя видно, что ждёт подписи', async () => {
  const o = await offered('Исправленный ждёт подписи', 11);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const d = (await result(o, 'Первый.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: '1. Нет даты\n2. Нет этажа' })).status, 201);
  const ref = `№ ${o.id.slice(0, 8).toUpperCase()}`;
  const mine = async () => (await spec.req('GET', '/api/today')).body.expert.returned.find((x) => x.id === o.id);
  const lead = async () => (await head.req('GET', '/api/today')).body.orgs[0].returned.find((x) => x.order_ref === ref);
  // Файл не удалён — исправленного нет.
  assert.equal((await mine()).fresh_file, null);
  assert.equal((await lead()).fresh_file, null);
  assert.equal((await spec.req('DELETE', `/api/documents/${d.id}`)).status, 204);
  assert.equal((await mine()).fresh_file, null, 'удалён, но новый ещё не загружен');
  const n = (await result(o, 'Исправленный.pdf')).body.document;
  assert.equal((await mine()).fresh_file.filename, 'Исправленный.pdf');
  const l = await lead();
  assert.equal(l.fresh_file.filename, 'Исправленный.pdf');
  assert.ok(Date.now() - Date.parse(l.fresh_file.at) < 60_000);
  // Подписал — возврат закрыт, строки нет ни у кого.
  assert.equal((await spec.req('POST', `/api/documents/${n.id}/sign`, { confirm: true })).status, 201);
  assert.equal(await mine(), undefined);
  assert.equal(await lead(), undefined);
});

test('исправленный файл больше суток не подписан (2.204): у эксперта отдельной строкой, в «Вернули» не повторяется', async () => {
  const o = await offered('Исправленный лежит сутки', 13);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const d = (await result(o, 'Сутки.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: 'Поправьте вывод' })).status, 201);
  assert.equal((await spec.req('DELETE', `/api/documents/${d.id}`)).status, 204);
  const n = (await result(o, 'Сутки-исправленный.pdf')).body.document;
  const today = async () => (await spec.req('GET', '/api/today')).body.expert;
  // Только что загружен — строки «не подписан» ещё нет, дело в «Вернули на доработку».
  let e = await today();
  assert.equal(e.fresh_late.find((x) => x.id === o.id), undefined);
  assert.equal(e.returned.find((x) => x.id === o.id).fresh_file.filename, 'Сутки-исправленный.pdf');
  // Прошло больше суток.
  await S.sql`update org_returns set created_at = now() - interval '26 hours' where order_id = ${o.id}`;
  await S.sql`update documents set created_at = now() - interval '25 hours' where id = ${n.id}`;
  e = await today();
  const x = e.fresh_late.find((r) => r.id === o.id);
  assert.equal(x.fresh_file.filename, 'Сутки-исправленный.pdf');
  assert.ok(x.by.startsWith('Руководитель'));
  assert.equal(e.returned.find((r) => r.id === o.id), undefined, 'в «Вернули на доработку» не повторяется');
  // Руководителю «Сегодня» эксперта не видно.
  assert.equal((await head.req('GET', '/api/today')).body.expert?.fresh_late?.some((r) => r.id === o.id) ?? false, false);
  // Подписал — строки нет.
  assert.equal((await spec.req('POST', `/api/documents/${n.id}/sign`, { confirm: true })).status, 201);
  e = await today();
  assert.equal(e.fresh_late.find((r) => r.id === o.id), undefined);
  assert.equal(e.returned.find((r) => r.id === o.id), undefined);
});

test('«Дела экспертов» (2.171): исправленный файл после возврата загружен и не подписан — для отбора руководителя', async () => {
  const o = await offered('Отбор исправленного файла', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const d = (await result(o, 'Первый.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: 'Нет даты осмотра' })).status, 201);
  const row = async () => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.equal((await row()).returned.fresh_file, null, 'возвращённый файл на месте — исправленного нет');
  assert.equal((await spec.req('DELETE', `/api/documents/${d.id}`)).status, 204);
  assert.equal((await row()).returned.fresh_file, null, 'удалён, но новый ещё не загружен');
  const n = (await result(o, 'Исправленный.pdf')).body.document;
  const c = await row();
  assert.equal(c.returned_open, true);
  assert.equal(c.returned.fresh_file.filename, 'Исправленный.pdf');
  assert.ok(Date.now() - Date.parse(c.returned.fresh_file.at) < 60_000);
  // Эксперт подписал — возврат закрыт, в отбор дело больше не попадает.
  assert.equal((await spec.req('POST', `/api/documents/${n.id}/sign`, { confirm: true })).status, 201);
  const after = await row();
  assert.equal(after.returned_open, false);
  assert.equal(after.returned, null);
});

test('«Мои заявки» (2.173): у дела, которое вернул руководитель, — отметка «вернули», пока эксперт не подписал исправленный', async () => {
  const o = await offered('Отметка «вернули» в списке', 13);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const d = (await result(o, 'Первый.pdf')).body.document;
  assert.equal((await spec.req('POST', `/api/documents/${d.id}/sign`, { confirm: true })).status, 201);
  const mine = async (who = spec) => (await who.req('GET', '/api/orders')).body.orders.find((x) => x.id === o.id);
  assert.equal((await mine()).returned, undefined, 'не возвращали — отметки нет');
  assert.equal((await head.req('POST', `/api/org-documents/${d.id}/return`, { comment: '1. Нет даты\n2. Нет этажа' })).status, 201);
  const r = (await mine()).returned;
  assert.equal(r.points, 2);
  assert.equal(r.left, 2);
  assert.equal(r.fresh_file, false);
  assert.ok(Date.now() - Date.parse(r.at) < 60_000);
  // Заказчик и руководитель отметки эксперта не получают — она только исполнителю.
  assert.equal((await mine(owner)).returned, undefined);
  assert.equal((await mine(head))?.returned, undefined);
  assert.equal((await spec.req('DELETE', `/api/documents/${d.id}`)).status, 204);
  const n = (await result(o, 'Исправленный.pdf')).body.document;
  assert.equal((await mine()).returned.fresh_file, true);
  // Подписал исправленный — возврат закрыт, отметки нет.
  assert.equal((await spec.req('POST', `/api/documents/${n.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await mine()).returned, undefined);
});

test('«Сегодня» у эксперта (2.369): дело на проверке у диспетчера 2 дня и дольше — отдельно, с временем сдачи', async () => {
  const slow = await offered('Долго на проверке', 9);
  assert.equal((await step(spec, slow, 'in_work')).status, 200);
  const quick = await offered('Только что сдано', 9);
  assert.equal((await step(spec, quick, 'in_work')).status, 200);
  // Сдано на проверку: у долгого — 50 часов назад, у второго — сейчас (по истории статусов, не по времени дела).
  await S.sql`update orders set status = 'review' where id in (${slow.id}, ${quick.id})`;
  await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
    values (${slow.id}, 'in_work', 'review', 'customer', now() - interval '50 hours'), (${quick.id}, 'in_work', 'review', 'customer', now())`;
  const e = (await spec.req('GET', '/api/today')).body.expert;
  assert.deepEqual(ids(e.review_long), [slow.id]);
  assert.ok(Date.now() - Date.parse(e.review_long[0].review_since) >= 49 * 3600_000, 'время — последний переход в проверку');
  assert.ok(ids(e.review).includes(quick.id) && !ids(e.review).includes(slow.id), 'долгое дело не повторяется в «Ждут проверки»');
  // Чужому эксперту и руководителю этого нет.
  assert.equal((await other.req('GET', '/api/today')).body.expert.review_long.length, 0);
});

test('заказчик не отвечает 2 дня (2.375): строка в «Сегодня» и первая готовая фраза — напоминание; ответил — пропало', async () => {
  const o = await offered('Дело с вопросом эксперта', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const say = (c, body) => c.req('POST', `/api/orders/${o.id}/messages`, { body });
  const silent = async (c = spec) => (await c.req('GET', '/api/today')).body.expert?.customer_silent ?? [];
  const phrases = async (c = spec) => (await c.req('GET', `/api/orders/${o.id}/messages`)).body.phrases ?? [];
  assert.equal((await say(spec, 'Здравствуйте! Подскажите, пожалуйста, удобные дату и время осмотра.')).status, 201);
  assert.deepEqual(await silent(), [], 'меньше 2 дней — не горит');
  assert.ok(!(await phrases()).some((p) => p.id === 'remind'));
  await S.sql`update order_messages set at = ${workingAgo(49 * 3600_000)} where order_id = ${o.id}`; // 2 рабочих дня (прогон 2.380)
  // Сообщение диспетчера — не ответ заказчика.
  assert.equal((await say(dispatcher, 'Заказчик, ответьте эксперту')).status, 201);
  let s = await silent();
  assert.deepEqual(s.map((x) => [x.id, x.count]), [[o.id, 1]]);
  assert.match(s[0].last, /^Здравствуйте! Подскажите/);
  assert.ok(Date.now() - Date.parse(s[0].since) > 48 * 3600_000);
  assert.deepEqual(await silent(other), [], 'чужой эксперт не видит');
  const [p] = await phrases();
  assert.equal(p.id, 'remind', 'напоминание — первой фразой');
  assert.match(p.text, /^Здравствуйте! Напоминаю о своём сообщении от \d+ [а-я]+: «Подскажите, пожалуйста, удобные дату и время осмотра\.»/);
  assert.equal((await phrases(owner)).length, 0, 'заказчику фраз нет');
  // Заказчик ответил — строки и фразы нет.
  assert.equal((await say(owner, 'Завтра в 10')).status, 201);
  assert.deepEqual(await silent(), []);
  assert.ok(!(await phrases()).some((p) => p.id === 'remind'));
  // Эксперт снова спросил и ждёт 2 дня; отправил напоминание — отсчёт заново.
  assert.equal((await say(spec, 'А кто откроет дверь?')).status, 201);
  await S.sql`update order_messages set at = ${workingAgo(3 * 86400_000)} where order_id = ${o.id}`;
  assert.deepEqual((await silent()).map((x) => [x.count, x.last]), [[1, 'А кто откроет дверь?']]);
  assert.equal((await say(spec, p.text)).status, 201);
  assert.deepEqual(await silent(), []);
});

test('заказчик не отвечает (2.375): запрошенные документы не пришли — только строка «Документы не пришли»', async () => {
  const o = await offered('Дело с документами без ответа', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/messages`, { body: 'Пришлите выписку' })).status, 201);
  await S.sql`update order_messages set at = ${workingAgo(3 * 86400_000)} where order_id = ${o.id}`;
  let t = (await spec.req('GET', '/api/today')).body.expert;
  assert.ok(ids(t.customer_silent).includes(o.id));
  const r = await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { custom: ['Выписка из ЕГРН'] });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  await S.sql`update doc_requests set requested_at = ${docsAskedAgo().at} where order_id = ${o.id}`;
  t = (await spec.req('GET', '/api/today')).body.expert;
  assert.ok(ids(t.docs_wait).includes(o.id));
  assert.ok(!ids(t.customer_silent).includes(o.id));
});

// Прогон 2.380: «2 дня» — рабочих: выходные и нерабочие праздники (2.371) не в счёт, заказчик в эти дни не работает.
test('заказчик не отвечает (прогон 2.380): выходные и праздник 4 ноября не в счёт', async () => {
  const o = await offered('Дело с вопросом перед праздником', 12);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/messages`, { body: 'Кто откроет дверь?' })).status, 201);
  const at = async (iso) => S.sql`update order_messages set at = ${iso}::timestamptz where order_id = ${o.id}`;
  const quiet = async (iso) => (await customerSilent(S.sql, [o.id], new Date(iso))).has(o.id);
  // Вторник 3 ноября, полдень: 4 ноября — праздник; к четвергу 13:00 рабочих — 12 + 13 часов.
  await at('2026-11-03T12:00:00+03:00');
  assert.equal(await quiet('2026-11-05T13:00:00+03:00'), false, 'по календарю 49 часов, рабочих — 25');
  assert.equal(await quiet('2026-11-06T12:00:00+03:00'), true, 'рабочих 48 часов — горит');
  // Пятница, 10:00: суббота и воскресенье не в счёт — горит со вторника 10:00.
  await at('2026-10-23T10:00:00+03:00');
  assert.equal(await quiet('2026-10-26T09:00:00+03:00'), false);
  assert.equal(await quiet('2026-10-27T09:59:00+03:00'), false);
  assert.equal(await quiet('2026-10-27T10:00:00+03:00'), true);
  // Будни подряд — как раньше, 48 часов.
  await at('2026-10-20T10:00:00+03:00');
  assert.equal(await quiet('2026-10-22T09:00:00+03:00'), false);
  assert.equal(await quiet('2026-10-22T10:00:00+03:00'), true);
});
