// Недостатки товара таблицей (задача 2.482, товароведческая экспертиза): эксперт ведёт в деле недостаток, где и какой
// размер, характер, признаки и номера фото осмотра; таблица — в раздел «5. Исследование» черновика и в Word.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { parseDraft } from '../../src/docs/docx.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { DEFECTS_HEAD, claimedLeft, defectsTable, placeDefects } from '../../src/orders/defects.mjs';
import { PARTS_HEAD, placeParts } from '../../src/orders/parts.mjs';

let S, owner, dispatcher, spec, other;
const FIELDS = { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться', questions: 'Есть ли недостаток? Каков его характер?',
  purchase: '12.03.2026, магазин, 54 990 ₽', goods_kind: 'gadget', model: 'Тестовый ноутбук X1, s/n TEST0001',
  defects: 'не включается\nтрещина на крышке', found_date: '20.04.2026', warranty_months: 12, seller_check: 'denied' };
const NATURES = [{ id: 'production', name: 'производственный' }, { id: 'operation', name: 'эксплуатационный' }];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004821');
  dispatcher = await login(S, '+79990004822');
  spec = await login(S, '+79990004823');
  other = await login(S, '+79990004824');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'goods'], ['expertise', 'car_damage']] });
  await makeSpecialist(S.sql, other.user.id, { permits: [['expertise', 'goods']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
async function inWork(service = 'goods', fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Товар: недостатки' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}
async function photos(o, steps) {
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const st of steps) {
    const [d] = await S.sql`insert into documents (order_id, uploaded_by, kind, filename, mime, size_bytes, storage_key)
      values (${o.id}, ${spec.user.id}, 'inspection', ${st + '.jpg'}, 'image/jpeg', 10, ${`test/${o.id}/${st}/${Math.random()}`}) returning id`;
    await S.sql`insert into inspection_photos (document_id, link_id, step) values (${d.id}, ${r.body.link.id}, ${st})`;
  }
}

test('описание модуля: недостатки только у товароведческой, раздел «5. Исследование» с пометкой defects; ошибки ловятся', () => {
  const reg = createRegistry();
  assert.deepEqual(reg.defects('expertise', 'goods').natures.map((a) => a.name), ['производственный', 'эксплуатационный', 'не установлен', 'не подтвердился']);
  assert.equal(reg.defects('expertise', 'car_damage'), null);
  assert.equal(reg.draftSections('expertise', 'goods').find((s) => s.defects).title, '5. Исследование');
  assert.throws(() => validateModule({ ...expertise, defects: { ...expertise.defects, services: ['nope'] } }), /нет услуги nope/);
  assert.throws(() => validateModule({ ...expertise, defects: { ...expertise.defects, natures: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] } }), /без повторов/);
  assert.throws(() => validateModule({ ...expertise, defects: { ...expertise.defects, natures: [{ id: 'a', name: 'A' }] } }), /от 2 до 6/);
});

test('таблица: номера фото — текущие, пустые признаки — прочерк; вставка под заголовок и замена; детали ДТП вставляются по-прежнему', () => {
  const noOf = new Map([['d1', 4], ['d2', 2]]);
  const list = [
    { defect: 'Не включается', place: 'Плата питания, следы окисления 3 мм', nature: 'operation', signs: 'Следы жидкости | коррозия контактов', photo_ids: ['d1', 'd2', 'gone'] },
    { defect: 'Трещина на крышке', place: 'Левый верхний угол, 4 см', nature: 'production', signs: '', photo_ids: [] },
  ];
  const t = defectsTable(list, NATURES, noOf);
  assert.deepEqual(t, [
    DEFECTS_HEAD,
    '| 1 | Не включается | Плата питания, следы окисления 3 мм | эксплуатационный | Следы жидкости / коррозия контактов | Фото 2, 4 |',
    '| 2 | Трещина на крышке | Левый верхний угол, 4 см | производственный | — | нет фото |',
  ]);
  assert.equal(defectsTable([], NATURES, noOf), null);
  const sections = [{ title: '4. Осмотр' }, { title: '5. Исследование', defects: true }];
  const body = '## 4. Осмотр\nОсмотрен.\n## 5. Исследование\nНедостатки описаны ниже.';
  const placed = placeDefects(body, sections, t);
  assert.equal(placed, `## 4. Осмотр\nОсмотрен.\n## 5. Исследование\n${t.join('\n')}\nНедостатки описаны ниже.`);
  const again = placeDefects(placed, sections, t.slice(0, 2));
  assert.equal(again, `## 4. Осмотр\nОсмотрен.\n## 5. Исследование\n${t.slice(0, 2).join('\n')}\nНедостатки описаны ниже.`, 'прежняя таблица заменена целиком');
  assert.equal(placeDefects(body, [{ title: '5. Исследование' }], t), body, 'нет раздела с defects — не трогаем');
  // Таблица деталей ДТП (2.471) — по-прежнему в раздел с parts.
  const car = placeParts('## 5. Исследование повреждений\nТекст', [{ title: '5. Исследование повреждений', parts: true }], [PARTS_HEAD, '| 1 | Бампер | Трещина | замена | нет фото |']);
  assert.equal(car, `## 5. Исследование повреждений\n${PARTS_HEAD}\n| 1 | Бампер | Трещина | замена | нет фото |\nТекст`);
  // В Word — таблица из шести столбцов.
  const tbl = parseDraft(placed).find((b) => b.type === 'table');
  assert.equal(tbl.rows.length, 3);
  assert.deepEqual(tbl.rows[0], ['№', 'Недостаток', 'Где и размер', 'Характер', 'Признаки', 'Фото осмотра']);
});

test('недостатки из заявки, которых нет в таблице: регистр, «ё», знаки и маркеры не важны', () => {
  const text = '- Не включается\n2) трещина на крышке.\n\nне включается\nЦарапины на корпусе';
  assert.deepEqual(claimedLeft(text, []), ['Не включается', 'трещина на крышке.', 'Царапины на корпусе']);
  assert.deepEqual(claimedLeft(text, [{ defect: 'Трещина на крышке' }, { defect: 'Ноутбук не включается' }]), ['Царапины на корпусе']);
  assert.deepEqual(claimedLeft('', []), []);
});

test('эксперт дела: добавить, изменить, удалить; фото — по номерам дела; стороны видят и только читают; таблица — в черновик от ИИ', async () => {
  const o = await inWork();
  await photos(o, ['goods_defect', 'goods_overview', 'goods_defect']); // в деле: Фото 1 — товар целиком, Фото 2 и 3 — недостаток
  const base = `/api/orders/${o.id}/defects`;
  const v0 = (await spec.req('GET', base)).body;
  assert.equal(v0.available, true);
  assert.equal(v0.can_write, true);
  assert.deepEqual(v0.defects, []);
  assert.equal(v0.table, null);
  assert.deepEqual(v0.claimed, ['не включается', 'трещина на крышке']);
  assert.deepEqual(v0.photos.map((p) => `${p.no} ${p.step}`), ['1 Товар целиком', '2 Недостаток крупно', '3 Недостаток крупно']);
  const crack = { defect: 'Трещина на крышке', place: 'Левый верхний угол, 4 см', nature: 'production', signs: 'Трещина от литника, следов удара нет', photos: [3, 2] };
  assert.equal((await spec.req('POST', base, { ...crack, defect: '' })).status, 400);
  assert.equal((await spec.req('POST', base, { ...crack, place: '' })).status, 400, 'где и размер — обязательно');
  const noNature = await spec.req('POST', base, { ...crack, nature: '' });
  assert.equal(noNature.status, 400);
  assert.match(noNature.body.message, /производственный, эксплуатационный/);
  assert.equal((await spec.req('POST', base, { ...crack, nature: 'guilty' })).status, 400, 'характер — только из модуля');
  const bad = await spec.req('POST', base, { ...crack, photos: [7] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /нет фото осмотра № 7/);
  const v1 = await spec.req('POST', base, crack);
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  const d1 = v1.body.defects[0];
  assert.deepEqual({ ...d1, id: undefined }, { id: undefined, no: 1, defect: 'Трещина на крышке', place: 'Левый верхний угол, 4 см', nature: 'production',
    nature_name: 'производственный', signs: 'Трещина от литника, следов удара нет', photos: [2, 3] });
  assert.deepEqual(v1.body.claimed, ['не включается'], 'записанный недостаток из заявки больше не подсказывается');
  const v2 = (await spec.req('POST', base, { defect: 'Не включается', place: 'Плата питания', nature: 'unknown', photos: [] })).body;
  assert.equal(v2.table[2], '| 2 | Не включается | Плата питания | не установлен | — | нет фото |');
  assert.deepEqual(v2.claimed, []);
  const d2 = v2.defects[1];
  const v3 = (await spec.req('PUT', `${base}/${d2.id}`, { defect: 'Не включается', place: 'Плата питания, окисление 3 мм', nature: 'operation', signs: 'Следы жидкости', photos: [1] })).body;
  assert.equal(v3.table[2], '| 2 | Не включается | Плата питания, окисление 3 мм | эксплуатационный | Следы жидкости | Фото 1 |');

  // Доснят шаг «Товар целиком» — номера сдвинулись, в таблице — текущие.
  await photos(o, ['goods_overview']);
  const v4 = (await spec.req('GET', base)).body;
  assert.deepEqual(v4.defects.map((d) => d.photos), [[3, 4], [1]]);

  // Остальные стороны видят, но не пишут; чужой эксперт — «не найдено».
  for (const c of [owner, dispatcher]) {
    const v = (await c.req('GET', base)).body;
    assert.equal(v.can_write, false);
    assert.equal(v.defects.length, 2);
    assert.equal((await c.req('POST', base, crack)).status, 403);
    assert.equal((await c.req('PUT', `${base}/${d1.id}`, crack)).status, 403);
    assert.equal((await c.req('DELETE', `${base}/${d1.id}`)).status, 403);
  }
  assert.equal((await other.req('GET', base)).status, 404);
  assert.equal((await spec.req('PUT', `${base}/999999`, crack)).status, 404);

  // Черновик от ИИ: таблица — сразу под заголовком «5. Исследование»; модели сказано не рисовать свою.
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const at = d.body.indexOf('## 5. Исследование');
  assert.ok(at >= 0);
  assert.deepEqual(d.body.slice(at).split('\n').slice(1, 4), v4.table);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.match(prompt, /НЕДОСТАТКИ ТОВАРА/);
  assert.match(prompt, /\| 1 \| Трещина на крышке \|/);

  // Удалить; после сдачи — только чтение.
  assert.equal((await spec.req('DELETE', `${base}/${d1.id}`)).body.defects.length, 1);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await spec.req('GET', base)).body.can_write, false);
  assert.equal((await spec.req('POST', base, crack)).status, 409);
});

test('не товароведческая — блока нет', async () => {
  const r = await inWork('car_damage', { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021,
    reg_number: 'А001АА777', accident_date: '14.09.2026', accident_place: 'г. Москва', damage: 'Задний бампер', method: 'osago' });
  assert.deepEqual((await spec.req('GET', `/api/orders/${r.id}/defects`)).body, { available: false });
  assert.equal((await spec.req('POST', `/api/orders/${r.id}/defects`, {})).status, 409);
});
