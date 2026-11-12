// Сверка с актом и расчётом страховой (задача 2.475, «Ущерб автомобилю после ДТП»): эксперт вносит детали и сумму страховой
// и свою сумму; программа сравнивает с таблицей повреждённых деталей — совпадает, добавлено, исключено — и считает разницу;
// блок — в раздел «5. Исследование повреждений» черновика и в Word.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { parseDraft } from '../../src/docs/docx.mjs';
import { PARTS_HEAD } from '../../src/orders/parts.mjs';
import { INS_HEAD, compareInsurer, insurerBlock, insurerParts, parseRub, placeInsurer, rubText } from '../../src/orders/insurer.mjs';

let S, owner, dispatcher, spec, other;
const FIELDS = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, vin: 'XTA00000000000001',
  reg_number: 'А001АА777', accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т', damage: 'Задний бампер, крышка багажника', method: 'osago' };

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004751');
  dispatcher = await login(S, '+79990004752');
  spec = await login(S, '+79990004753');
  other = await login(S, '+79990004754');
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
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'ДТП: страховая' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

test('суммы и список деталей страховой: разбор и запись', () => {
  assert.equal(parseRub('84 500'), 8450000);
  assert.equal(parseRub('84 500,5 руб.'), 8450050);
  assert.equal(parseRub('112300.75'), 11230075);
  assert.equal(parseRub('сто'), null);
  assert.equal(parseRub('-5'), null);
  assert.equal(rubText(8450000), '84 500 руб.');
  assert.equal(rubText(-2780050), '−27 800,50 руб.');
  assert.deepEqual(insurerParts('1. Бампер задний\n\n2) крышка багажника; Бампер задний\n Фонарь задний левый '), ['Бампер задний', 'крышка багажника', 'Фонарь задний левый']);
});

test('сравнение: падежи и порядок слов не важны; добавлено, исключено, разница; блок под таблицей деталей и замена прежнего', () => {
  const calc = { basis: 'акт и калькуляция № 12 от 20.09.2026', wear: 'with', insurer_kop: 8450000, own_kop: 11230000, parts: ['бампера заднего', 'Фонарь задний левый'] };
  const ours = ['Бампер задний', 'Крышка багажника'];
  const cmp = compareInsurer(calc, ours);
  assert.deepEqual(cmp.rows.map((r) => `${r.part}:${r.kind}`), ['Бампер задний:both', 'Крышка багажника:added', 'Фонарь задний левый:excluded']);
  assert.deepEqual([cmp.both, cmp.added, cmp.excluded, cmp.diff_kop], [1, 1, 1, 2780000]);
  const block = insurerBlock(calc, ours);
  assert.equal(block[0], 'Сравнение с расчётом страховой (акт и калькуляция № 12 от 20.09.2026): деталей совпадает — 1, добавлено экспертом — 1, '
    + 'исключено экспертом — 1. Сумма с учётом износа: у страховой — 84 500 руб., по расчёту эксперта — 112 300 руб., разница — +27 800 руб.');
  assert.deepEqual(block.slice(1), ['', INS_HEAD,
    '| 1 | Бампер задний (у страховой — «бампера заднего») | есть | есть | совпадает |',
    '| 2 | Крышка багажника | нет | есть | добавлено экспертом |',
    '| 3 | Фонарь задний левый | есть | нет | исключено экспертом |']);
  assert.match(insurerBlock({ ...calc, own_kop: null, basis: '' }, ours)[0], /^Сравнение с расчётом страховой: .*по расчёту эксперта — \[заполнить\]\.$/);

  const sections = [{ title: '4. Осмотр' }, { title: '5. Исследование повреждений', parts: true }];
  const table = [PARTS_HEAD, '| 1 | Бампер задний | Разрыв | замена | Фото 1 |'];
  const body = `## 4. Осмотр\nОсмотрен.\n## 5. Исследование повреждений\n${table.join('\n')}\nПовреждения соответствуют ДТП.`;
  const placed = placeInsurer(body, sections, block);
  assert.equal(placed, `## 4. Осмотр\nОсмотрен.\n## 5. Исследование повреждений\n${table.join('\n')}\n\n${block.join('\n')}\nПовреждения соответствуют ДТП.`);
  const fewer = insurerBlock({ ...calc, parts: [] }, ['Бампер задний']);
  assert.equal(placeInsurer(placed, sections, fewer), `## 4. Осмотр\nОсмотрен.\n## 5. Исследование повреждений\n${table.join('\n')}\n\n${fewer.join('\n')}\nПовреждения соответствуют ДТП.`, 'прежний блок заменён целиком');
  const bare = '## 5. Исследование повреждений\nТекст.';
  assert.equal(placeInsurer(bare, sections, block), `## 5. Исследование повреждений\n${block.join('\n')}\nТекст.`, 'нет таблицы деталей — под заголовком');
  assert.equal(placeInsurer(bare, [{ title: '5. Исследование повреждений' }], block), bare, 'нет раздела с parts — не трогаем');
  // В Word — таблица из пяти столбцов.
  const tbls = parseDraft(placed).filter((b) => b.type === 'table');
  assert.deepEqual(tbls.at(-1).rows[0], ['№', 'Деталь', 'У страховой', 'У эксперта', 'Итог']);
  assert.equal(tbls.at(-1).rows.length, 4);
});

test('эксперт дела вносит, меняет, убирает; сравнение — с текущей таблицей деталей; стороны только читают; в черновике от ИИ', async () => {
  const o = await inWork();
  const base = `/api/orders/${o.id}/insurer`;
  const v0 = (await spec.req('GET', base)).body;
  assert.equal(v0.available, true);
  assert.equal(v0.can_write, true);
  assert.equal(v0.calc, null);
  const calc = { basis: 'акт осмотра № 12', parts: 'бампер задний\nфонарь задний левый', wear: 'with', insurer: '84 500', own: '' };
  assert.equal((await spec.req('PUT', base, { ...calc, wear: 'half' })).status, 400);
  assert.equal((await spec.req('PUT', base, { ...calc, insurer: 'много' })).status, 400);
  assert.equal((await spec.req('PUT', base, { ...calc, own: 'x' })).status, 400);
  assert.equal((await spec.req('PUT', base, { ...calc, basis: 'а'.repeat(201) })).status, 400);
  const v1 = (await spec.req('PUT', base, calc)).body;
  assert.equal(v1.calc.insurer_kop, 8450000);
  assert.equal(v1.calc.own_kop, null);
  assert.deepEqual([v1.compare.both, v1.compare.added, v1.compare.excluded], [0, 0, 2], 'таблица деталей пуста — всё исключено');

  // Эксперт записал детали — сравнение пересчиталось само.
  for (const part of ['Задний бампер', 'Крышка багажника']) {
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/parts`, { part, damage: 'Вмятина', actions: ['repair'], photos: [] })).status, 201);
  }
  const v2 = (await spec.req('PUT', base, { ...calc, own: '112 300' })).body;
  assert.deepEqual([v2.compare.both, v2.compare.added, v2.compare.excluded, v2.compare.diff_kop], [1, 1, 1, 2780000]);
  assert.match(v2.line, /разница — \+27 800 руб\.$/);

  for (const c of [owner, dispatcher]) {
    const v = (await c.req('GET', base)).body;
    assert.equal(v.can_write, false);
    assert.equal(v.line, v2.line);
    assert.equal((await c.req('PUT', base, calc)).status, 403);
    assert.equal((await c.req('DELETE', base)).status, 403);
  }
  assert.equal((await other.req('GET', base)).status, 404);

  // Черновик от ИИ: блок — под таблицей повреждённых деталей; модели сказано не повторять.
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const lines = d.body.split('\n');
  const t = lines.findIndex((l) => l === PARTS_HEAD);
  assert.ok(t >= 0);
  assert.equal(lines[t + 3], '');
  assert.deepEqual(lines.slice(t + 4, t + 4 + v2.block.length), v2.block);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.match(prompt, /СВЕРКА С РАСЧЁТОМ СТРАХОВОЙ/);

  // Убрать; после сдачи — только чтение.
  assert.equal((await spec.req('DELETE', base)).body.calc, null);
  assert.equal((await spec.req('PUT', base, calc)).status, 200);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await spec.req('GET', base)).body.can_write, false);
  assert.equal((await spec.req('PUT', base, calc)).status, 409);
});

test('не ДТП — блока нет', async () => {
  const r = await inWork('realty', { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 47', area: '44' });
  assert.deepEqual((await spec.req('GET', `/api/orders/${r.id}/insurer`)).body, { available: false });
  assert.equal((await spec.req('PUT', `/api/orders/${r.id}/insurer`, {})).status, 409);
});
