// Повреждённые детали таблицей (задача 2.471, «Ущерб автомобилю после ДТП»): эксперт ведёт в деле деталь, повреждение,
// ремонтное воздействие и номера фото осмотра; таблица — в раздел «5. Исследование повреждений» черновика и в Word.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { parseDraft } from '../../src/docs/docx.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { PARTS_HEAD, partsTable, placeParts } from '../../src/orders/parts.mjs';

let S, owner, dispatcher, spec, other;
const FIELDS = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, vin: 'XTA00000000000001',
  reg_number: 'А001АА777', accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т', damage: 'Задний бампер, крышка багажника', method: 'osago' };
const ACTIONS = [{ id: 'replace', name: 'замена' }, { id: 'repair', name: 'ремонт' }, { id: 'paint', name: 'окраска' }];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004711');
  dispatcher = await login(S, '+79990004712');
  spec = await login(S, '+79990004713');
  other = await login(S, '+79990004714');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'car_damage'], ['expertise', 'realty']] });
  await makeSpecialist(S.sql, other.user.id, { permits: [['expertise', 'car_damage']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
async function inWork(service = 'car_damage', fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'ДТП: детали' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}
// Фото осмотра в деле по шагам (номера в деле — по порядку шагов осмотра, src/docs/photos.mjs).
async function photos(o, steps) {
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const st of steps) {
    const [d] = await S.sql`insert into documents (order_id, uploaded_by, kind, filename, mime, size_bytes, storage_key)
      values (${o.id}, ${spec.user.id}, 'inspection', ${st + '.jpg'}, 'image/jpeg', 10, ${`test/${o.id}/${st}/${Math.random()}`}) returning id`;
    await S.sql`insert into inspection_photos (document_id, link_id, step) values (${d.id}, ${r.body.link.id}, ${st})`;
  }
}

test('описание модуля: детали только у ущерба после ДТП, раздел «Исследование повреждений» с пометкой parts; ошибки ловятся', () => {
  const reg = createRegistry();
  assert.deepEqual(reg.parts('expertise', 'car_damage').actions.map((a) => a.id), ['replace', 'repair', 'paint']);
  assert.equal(reg.parts('expertise', 'realty'), null);
  assert.equal(reg.draftSections('expertise', 'car_damage').find((s) => s.parts).title, '5. Исследование повреждений');
  assert.throws(() => validateModule({ ...expertise, parts: { ...expertise.parts, services: ['nope'] } }), /нет услуги nope/);
  assert.throws(() => validateModule({ ...expertise, parts: { ...expertise.parts, actions: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] } }), /без повторов/);
  assert.throws(() => validateModule({ ...expertise, parts: { ...expertise.parts, actions: [] } }), /от 1 до 5/);
});

test('таблица: номера фото — текущие, «|» в тексте не ломает строку; вставка под заголовок и замена прежней целиком', () => {
  const noOf = new Map([['d1', 3], ['d2', 1]]);
  const list = [
    { part: 'Бампер задний', damage: 'Разрыв | трещина 10 см', actions: ['replace', 'paint'], photo_ids: ['d1', 'd2', 'gone'] },
    { part: 'Крышка багажника', damage: 'Вмятина', actions: ['repair'], photo_ids: [] },
  ];
  const t = partsTable(list, ACTIONS, noOf);
  assert.deepEqual(t, [
    PARTS_HEAD,
    '| 1 | Бампер задний | Разрыв / трещина 10 см | замена, окраска | Фото 1, 3 |',
    '| 2 | Крышка багажника | Вмятина | ремонт | нет фото |',
  ]);
  assert.equal(partsTable([], ACTIONS, noOf), null);
  const sections = [{ title: '4. Осмотр' }, { title: '5. Исследование повреждений', parts: true }];
  const body = '## 4. Осмотр\nОсмотрен.\n## 5. Исследование повреждений\nПовреждения соответствуют ДТП.';
  const placed = placeParts(body, sections, t);
  assert.equal(placed, `## 4. Осмотр\nОсмотрен.\n## 5. Исследование повреждений\n${t.join('\n')}\nПовреждения соответствуют ДТП.`);
  const shorter = t.slice(0, 2);
  const again = placeParts(placed, sections, shorter);
  assert.equal(again, `## 4. Осмотр\nОсмотрен.\n## 5. Исследование повреждений\n${shorter.join('\n')}\nПовреждения соответствуют ДТП.`, 'прежняя таблица заменена целиком');
  assert.equal(placeParts(body, [{ title: '5. Исследование повреждений' }], t), body, 'нет раздела с parts — не трогаем');
  // В Word — таблица из пяти столбцов.
  const tbl = parseDraft(placed).find((b) => b.type === 'table');
  assert.equal(tbl.rows.length, 3);
  assert.deepEqual(tbl.rows[0], ['№', 'Деталь', 'Повреждение', 'Ремонтное воздействие', 'Фото осмотра']);
});

test('эксперт дела: добавить, изменить, удалить; фото — по номерам дела; стороны видят и только читают; таблица — в черновик от ИИ', async () => {
  const o = await inWork();
  await photos(o, ['car_rear', 'car_front', 'car_rear']); // в деле: Фото 1 — спереди, Фото 2 и 3 — сзади
  const base = `/api/orders/${o.id}/parts`;
  const v0 = (await spec.req('GET', base)).body;
  assert.equal(v0.available, true);
  assert.equal(v0.can_write, true);
  assert.deepEqual(v0.parts, []);
  assert.equal(v0.table, null);
  assert.deepEqual(v0.photos.map((p) => `${p.no} ${p.step}`), ['1 Спереди', '2 Сзади', '3 Сзади']);
  const bumper = { part: 'Бампер задний', damage: 'Разрыв в правой части', actions: ['paint', 'replace'], photos: [3, 2] };
  assert.equal((await spec.req('POST', base, { ...bumper, part: '' })).status, 400);
  assert.equal((await spec.req('POST', base, { ...bumper, actions: [] })).status, 400, 'без ремонтного воздействия');
  assert.equal((await spec.req('POST', base, { ...bumper, actions: ['weld'] })).status, 400, 'воздействие — только из модуля');
  const bad = await spec.req('POST', base, { ...bumper, photos: [7] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /нет фото осмотра № 7/);
  const v1 = await spec.req('POST', base, bumper);
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  const p1 = v1.body.parts[0];
  assert.deepEqual({ ...p1, id: undefined }, { id: undefined, no: 1, part: 'Бампер задний', damage: 'Разрыв в правой части', actions: ['replace', 'paint'],
    action_names: ['замена', 'окраска'], photos: [2, 3] });
  const v2 = (await spec.req('POST', base, { part: 'Крышка багажника', damage: 'Вмятина', actions: ['repair', 'paint'], photos: [] })).body;
  assert.equal(v2.table[2], '| 2 | Крышка багажника | Вмятина | ремонт, окраска | нет фото |');
  const p2 = v2.parts[1];
  const v3 = (await spec.req('PUT', `${base}/${p2.id}`, { part: 'Крышка багажника', damage: 'Вмятина 5 см', actions: ['repair', 'paint'], photos: [2] })).body;
  assert.equal(v3.table[2], '| 2 | Крышка багажника | Вмятина 5 см | ремонт, окраска | Фото 2 |');

  // Доснят шаг «Спереди» — номера сдвинулись, в таблице — текущие.
  await photos(o, ['car_front']);
  const v4 = (await spec.req('GET', base)).body;
  assert.deepEqual(v4.parts.map((p) => p.photos), [[3, 4], [3]]);

  // Остальные стороны видят, но не пишут; чужой эксперт — «не найдено».
  for (const c of [owner, dispatcher]) {
    const v = (await c.req('GET', base)).body;
    assert.equal(v.can_write, false);
    assert.equal(v.parts.length, 2);
    assert.equal((await c.req('POST', base, bumper)).status, 403);
    assert.equal((await c.req('PUT', `${base}/${p1.id}`, bumper)).status, 403);
    assert.equal((await c.req('DELETE', `${base}/${p1.id}`)).status, 403);
  }
  assert.equal((await other.req('GET', base)).status, 404);
  assert.equal((await spec.req('PUT', `${base}/999999`, bumper)).status, 404);

  // Черновик от ИИ: таблица — сразу под заголовком «5. Исследование повреждений»; модели сказано не рисовать свою.
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const at = d.body.indexOf('## 5. Исследование повреждений');
  assert.ok(at >= 0);
  assert.deepEqual(d.body.slice(at).split('\n').slice(1, 4), v4.table);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.match(prompt, /ПОВРЕЖДЁННЫЕ ДЕТАЛИ/);
  assert.match(prompt, /\| 1 \| Бампер задний \|/);

  // Удалить; после сдачи — только чтение.
  assert.equal((await spec.req('DELETE', `${base}/${p1.id}`)).body.parts.length, 1);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await spec.req('GET', base)).body.can_write, false);
  assert.equal((await spec.req('POST', base, bumper)).status, 409);
});

test('не ДТП — блока нет', async () => {
  const r = await inWork('realty', { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 47', area: '44' });
  assert.deepEqual((await spec.req('GET', `/api/orders/${r.id}/parts`)).body, { available: false });
  assert.equal((await spec.req('POST', `/api/orders/${r.id}/parts`, {})).status, 409);
});
