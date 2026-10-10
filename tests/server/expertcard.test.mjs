// Карточка эксперта (2.35): квалификация, допуски, досье без копий, итоги работы (сдано в срок, возвраты), загрузка,
// история дел без данных заказчика; видят диспетчер и руководитель организации эксперта. Итоги идут в «качество» подбора.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { scoreSpecialist } from '../../src/matching/score.mjs';

let S, owner, dispatcher, spec, head, headOther, org;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Карточная, 3', area: '40' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003601');
  dispatcher = await login(S, '+79990003602');
  spec = await login(S, '+79990003603');
  head = await login(S, '+79990003604');
  headOther = await login(S, '+79990003605');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  org = await makeOrg(S.sql, 'ООО «Карточка»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, spec.user.id, 'member');
  const other = await makeOrg(S.sql, 'ООО «Другая»');
  await addMember(S.sql, other.id, headOther.user.id, 'head');
  await spec.req('PATCH', '/api/me', { full_name: 'Эксперт Карточкин' });
  assert.equal((await spec.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
});
after(async () => { await S?.close(); });

async function step(c, o, to, reason) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...(reason ? { reason } : {}) });
}

test('качество в подборе: доля принятых, в срок и без возвратов — среднее; мало данных — нейтрально', () => {
  const spec0 = { regions: ['moscow'], capacity: 5, external_load: 0 };
  const q = (stats) => scoreSpecialist(spec0, { open: 0, offers: 0, accepted: 0, ...stats }, { fields: {} }, null).features.quality;
  assert.equal(q({}).score, 70);
  assert.equal(q({ done: 2, on_time: 0, returned: 2 }).score, 70, 'двух дел мало');
  assert.equal(q({ done: 4, on_time: 2, returned: 1 }).score, 63, '(50 + 75) / 2');
  assert.match(q({ done: 4, on_time: 2, returned: 1 }).note, /в срок 2 из 4; возвратов на доработку: 1/);
  assert.equal(q({ offers: 4, accepted: 4, done: 4, on_time: 4, returned: 0 }).score, 100);
});

test('карточка эксперта: досье без копий, допуски, итоги, история; руководитель своей организации — да, чужой — нет', async () => {
  // Досье: аттестат с копией.
  const item = (await spec.req('POST', '/api/specialist/me/dossier', { kind: 'certificate', title: 'Оценка недвижимости', number: '012345-1', valid_until: addDays(todayMsk(), 200) })).body;
  assert.ok(item.item?.id || item.items, JSON.stringify(item));
  // Два сданных дела: одно в срок, одно — с возвратом от диспетчера.
  for (const [title, back] of [['Дело в срок', false], ['Дело с возвратом', true]]) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 5), fields: FIELDS });
    await step(owner, o, 'matching');
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
    assert.equal((await step(spec, o, 'in_work')).status, 200);
    await S.sql`update orders set status = 'review' where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, actor_id) values (${o.id}, 'in_work', 'review', 'executor', ${spec.user.id})`;
    if (back) {
      assert.equal((await step(dispatcher, o, 'in_work', 'Нет фото')).status, 200);
      await S.sql`update orders set status = 'review' where id = ${o.id}`;
    }
    await S.sql`update orders set status = 'done' where id = ${o.id}`;
  }
  for (const c of [dispatcher, head, spec]) {
    const r = await c.req('GET', `/api/specialists/${spec.user.id}/card`);
    assert.equal(r.status, 200);
    const card = r.body;
    assert.equal(card.specialist.full_name, 'Эксперт Карточкин');
    assert.equal(card.specialist.org.name, 'ООО «Карточка»');
    assert.deepEqual(card.dossier.map((d) => [d.kind, d.number, d.has_copy, d.state]), [['certificate', '012345-1', false, 'ok']]);
    assert.ok(!('file' in card.dossier[0]), 'копии и ссылки на них в карточке нет');
    assert.deepEqual([card.stats.done, card.stats.on_time, card.stats.returned, card.stats.accepted], [2, 2, 1, 2]);
    assert.equal(card.history.length, 2);
    assert.deepEqual(card.history.map((h) => h.returns).sort(), [0, 1]);
    const text = JSON.stringify(card);
    for (const secret of ['Дело в срок', 'Карточная', owner.user.id]) assert.ok(!text.includes(secret), `в карточке нет: ${secret}`);
  }
  assert.equal((await headOther.req('GET', `/api/specialists/${spec.user.id}/card`)).status, 404);
  assert.equal((await owner.req('GET', `/api/specialists/${spec.user.id}/card`)).status, 404);
  // Ушёл из организации — бывший руководитель карточку не видит.
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${spec.user.id}`;
  assert.equal((await head.req('GET', `/api/specialists/${spec.user.id}/card`)).status, 404);
});

// 2.139: сданное за год по услугам и средний срок от принятия до «готово»; дела старше года и не сданные — не в счёт.
test('карточка эксперта: сдано за год по услугам, позже срока и средний срок от принятия', async () => {
  const spec2 = await login(S, '+79990003606');
  await makeSpecialist(S.sql, spec2.user.id);
  await addMember(S.sql, org.id, spec2.user.id, 'member');
  assert.equal((await spec2.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const today = todayMsk();
  // [услуга, принял (дней назад), «готово» (дней назад), срок (дней назад; меньше нуля — впереди), статус]
  const cases = [
    ['realty', 8, 4, 6, 'done'], // 4 дня, позже срока
    ['realty', 5, 3, 1, 'closed'], // 2 дня, в срок
    ['vehicle', 3, 0, -10, 'done'], // 3 дня
    ['vehicle', null, 1, -10, 'done'], // без отметки о принятии — в число, но не в среднее
    ['realty', 400, 380, 390, 'done'], // больше года назад — не в счёт
    ['realty', 2, null, -10, 'in_work'], // не сдано
  ];
  for (const [service, taken, done, deadline, status] of cases) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Дело за год' })).body.order;
    await S.sql`update orders set executor_user_id = ${spec2.user.id}, status = ${status},
                  deadline = ${addDays(today, -deadline)} where id = ${o.id}`;
    if (taken != null) {
      await S.sql`insert into order_offers (order_id, specialist_id, score, outcome, outcome_at)
                  values (${o.id}, ${spec2.user.id}, '{}', 'accepted', now() - make_interval(days => ${taken}))`;
    }
    if (done != null) {
      await S.sql`insert into order_status_history (order_id, from_status, to_status, side, actor_id, at)
                  values (${o.id}, 'review', 'done', 'dispatcher', ${dispatcher.user.id}, now() - make_interval(days => ${done}))`;
      // Повторное «готово» позже (после «закрыто» и возврата) не сдвигает дату первой сдачи.
      await S.sql`insert into order_status_history (order_id, from_status, to_status, side, actor_id, at)
                  values (${o.id}, 'review', 'done', 'dispatcher', ${dispatcher.user.id}, now())`;
    }
  }
  for (const c of [dispatcher, head, spec2]) {
    const r = await c.req('GET', `/api/specialists/${spec2.user.id}/card`);
    assert.equal(r.status, 200);
    const y = r.body.year;
    assert.equal(y.since, addDays(today, -364));
    assert.deepEqual([y.done, y.done_late, y.avg_days], [4, 1, 3], 'среднее (4 + 2 + 3) / 3');
    assert.deepEqual(y.by_service.map((x) => [x.service, x.name, x.done, x.done_late, x.avg_days]), [
      ['realty', 'Оценка недвижимости', 2, 1, 3],
      ['vehicle', y.by_service[1].name, 2, 0, 3],
    ]);
    assert.ok(!JSON.stringify(y).includes('Дело за год'), 'без названий заявок');
  }
});

// 2.143: «Сейчас в работе» — дела в работе, на проверке и предложенные: срок, «горит», дни без движения, открытая просьба
// о переносе срока. Сданные и отменённые — нет. Руководителю организации эксперта — `org_id` (открыть в «Делах экспертов»).
test('карточка эксперта: сейчас в работе — сроки, без движения, просьба о переносе; без заказчика', async () => {
  const spec3 = await login(S, '+79990003607');
  await makeSpecialist(S.sql, spec3.user.id);
  await addMember(S.sql, org.id, spec3.user.id, 'member');
  assert.equal((await spec3.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const today = todayMsk();
  // [статус, срок (дней вперёд), последнее движение (дней назад), просьба о переносе]
  const cases = [
    ['in_work', 1, 5, true], // горит, без движения 5 дней, просит перенос
    ['review', 10, 0, false],
    ['awaiting_executor', 20, null, false],
    ['done', 3, 1, false], // сдано — не в блоке
    ['cancelled', 3, 1, false],
  ];
  const ids = [];
  for (const [status, deadline, moved, extend] of cases) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело сейчас' })).body.order;
    ids.push(o.id);
    await S.sql`update orders set executor_user_id = ${spec3.user.id}, status = ${status}, deadline = ${addDays(today, deadline)},
                  updated_at = now() - make_interval(days => ${moved ?? 0}) where id = ${o.id}`;
    if (moved != null) {
      await S.sql`update order_status_history set at = now() - make_interval(days => ${moved + 1}) where order_id = ${o.id}`;
      await S.sql`insert into order_status_history (order_id, from_status, to_status, side, actor_id, at)
                  values (${o.id}, 'matching', ${status}, 'executor', ${spec3.user.id}, now() - make_interval(days => ${moved}))`;
    }
    if (extend) {
      await S.sql`insert into deadline_requests (order_id, requested_by, old_deadline, new_deadline, reason, requested_at)
                  values (${o.id}, ${spec3.user.id}, ${addDays(today, deadline)}, ${addDays(today, deadline + 7)}, 'Жду выписку из ЕГРН',
                          now() - make_interval(days => 6))`;
    }
  }
  for (const [c, orgId] of [[dispatcher, null], [head, org.id], [spec3, null]]) {
    const r = await c.req('GET', `/api/specialists/${spec3.user.id}/card`);
    assert.equal(r.status, 200);
    const now = r.body.now;
    assert.equal(now.org_id, orgId, 'ссылка к делу — только руководителю организации эксперта');
    assert.deepEqual(now.cases.map((x) => [x.status, x.hot, x.idle, x.idle_days, x.extend?.new_deadline ?? null]), [
      ['in_work', true, true, 5, addDays(today, 8)],
      ['review', false, false, 0, null],
      ['awaiting_executor', false, false, null, null],
    ]);
    assert.equal(now.cases[0].service, 'Оценка недвижимости');
    const text = JSON.stringify(now);
    for (const secret of ['Дело сейчас', 'Жду выписку', owner.user.id, ...ids]) assert.ok(!text.includes(secret), `в блоке нет: ${secret}`);
  }
});

// 2.156: «Возвраты за год» — только руководителю организации эксперта: возвраты его организации за 365 дней, по скольким
// делам, последний день и частые пункты замечаний (одинаковые без учёта регистра и точки — один пункт). Возвраты старше года
// и чужой организации — не в счёт; диспетчеру и самому эксперту блока нет.
test('карточка эксперта: возвраты за год — руководителю, частые пункты, без чужих и старых', async () => {
  const spec4 = await login(S, '+79990003608');
  await makeSpecialist(S.sql, spec4.user.id);
  await addMember(S.sql, org.id, spec4.user.id, 'member');
  assert.equal((await spec4.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const other = await makeOrg(S.sql, 'ООО «Прежняя»');
  const orders = [];
  for (let i = 0; i < 2; i++) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело с возвратом' })).body.order;
    await S.sql`update orders set executor_user_id = ${spec4.user.id}, status = 'in_work', deadline = ${addDays(todayMsk(), 5)} where id = ${o.id}`;
    const [d] = await S.sql`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key)
      values (${o.id}, ${spec4.user.id}, 'отчёт.pdf', 'application/pdf', 1, ${`test/2156/${o.id}`}) returning id`;
    orders.push({ ...o, doc: d.id });
  }
  const ret = async (orgId, o, items, daysAgo) => {
    const [{ id }] = await S.sql`insert into org_returns (order_id, document_id, org_id, executor_user_id, returned_by, filename, comment, created_at)
      values (${o.id}, ${o.doc}, ${orgId}, ${spec4.user.id}, ${head.user.id}, 'отчёт.pdf', ${items.join('\n') || 'Поправьте'},
              now() - make_interval(days => ${daysAgo}::int)) returning id`;
    for (const [i, text] of items.entries()) await S.sql`insert into org_return_items (return_id, n, text) values (${id}, ${i + 1}, ${text})`;
  };
  await ret(org.id, orders[0], ['Нет даты осмотра.', 'Не указан этаж'], 40);
  await ret(org.id, orders[0], ['нет  даты осмотра'], 10);
  await ret(org.id, orders[1], ['Нет даты осмотра', 'Нет подписи на титуле'], 2);
  await ret(org.id, orders[1], [], 1); // без пунктов — возврат в счёт, пунктов нет
  await ret(org.id, orders[1], ['Старое замечание'], 400); // больше года назад
  await ret(other.id, orders[1], ['Чужое замечание'], 3); // другая организация
  const r = (await head.req('GET', `/api/specialists/${spec4.user.id}/card`)).body.returns_year;
  assert.equal(r.since, addDays(todayMsk(), -364));
  assert.deepEqual([r.n, r.cases, r.last_day], [4, 2, addDays(todayMsk(), -1)]);
  assert.deepEqual(r.top_remarks, [
    { text: 'Нет даты осмотра', n: 3 },
    { text: 'Нет подписи на титуле', n: 1 },
    { text: 'Не указан этаж', n: 1 },
  ]);
  const text = JSON.stringify(r);
  for (const secret of ['Дело с возвратом', 'Старое замечание', 'Чужое замечание', owner.user.id, ...orders.map((o) => o.id)]) {
    assert.ok(!text.includes(secret), `в блоке нет: ${secret}`);
  }
  for (const c of [dispatcher, spec4]) assert.equal((await c.req('GET', `/api/specialists/${spec4.user.id}/card`)).body.returns_year, null);
  // Возвратов не было — блок есть, нули.
  const spec5 = await login(S, '+79990003609');
  await makeSpecialist(S.sql, spec5.user.id);
  await addMember(S.sql, org.id, spec5.user.id, 'member');
  assert.equal((await spec5.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const z = (await head.req('GET', `/api/specialists/${spec5.user.id}/card`)).body.returns_year;
  assert.deepEqual([z.n, z.cases, z.last_day, z.top_remarks], [0, 0, null, []]);
});
