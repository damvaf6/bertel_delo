// Задача 2.492 (оценка транспорта): в заявке — двигатель (объём, мощность), коробка, привод, цвет, ДТП, владелец и
// балансовая стоимость; все необязательны; строкой «Из заявки: …» — в раздел «7. Описание объекта» черновика от ИИ.
// Номера +7 999 000-52-01…03 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine, placeFacts } from '../../src/orders/facts.mjs';
import { pledgeLine } from '../../src/orders/pledge.mjs';
import { createRegistry, validateModule, DEFAULT_MODULES } from '../../src/modules/index.mjs';

const ALL = { engine_cc: 1998, engine_hp: 150, gearbox: 'auto', drive: 'full', color: 'белый', accidents: 'repaired', owner_kind: 'org', book_value: 1250000 };
const LINE = `${FACTS_HEAD} объём двигателя — 1998 куб. см; мощность двигателя — 150 л. с.; коробка передач — автоматическая; привод — полный; цвет — белый; ДТП — был, отремонтирован; владелец — организация; балансовая стоимость — 1 250 000 руб.`;

test('строка «Из заявки» и место в разделе; описание модуля проверяет поля', async () => {
  const registry = createRegistry();
  const fields = registry.service('expertise', 'vehicle').fields;
  const sec = registry.draftSections('expertise', 'vehicle').find((s) => s.facts);
  assert.equal(sec.id, 'v_object');
  assert.equal(factsLine(fields, sec.facts, ALL), LINE);
  assert.equal(factsLine(fields, sec.facts, { gearbox: 'manual', color: '  серый  металлик. ' }), `${FACTS_HEAD} коробка передач — механическая; цвет — серый металлик.`);
  assert.equal(factsLine(fields, sec.facts, {}), null, 'ничего не заполнено — строки нет');
  assert.equal(factsLine(fields, sec.facts, { gearbox: 'нет-такого' }), null);
  // У других услуг раздела с facts нет.
  assert.equal(registry.draftSections('expertise', 'realty').some((s) => s.facts), false);

  const sections = [{ title: '6. Сведения об оценщике' }, { title: '7. Описание объекта оценки', pledge: true, facts: sec.facts }];
  const body = '## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\nЛегковой автомобиль.';
  const p = pledgeLine({ checked_on: '2026-11-10', result: 'none' });
  const placed = placeFacts(body.replace('оценки\n', `оценки\n${p}\n`), sections, LINE);
  assert.equal(placed, `## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\n${LINE}\n${p}\nЛегковой автомобиль.`, 'над строкой о залоге');
  const again = factsLine(fields, sec.facts, { color: 'чёрный' });
  assert.equal(placeFacts(placed, sections, again), placed.replace(LINE, again), 'прежняя строка заменена');
  assert.equal(placeFacts(body, [{ title: '7. Описание объекта оценки' }], LINE), body, 'нет раздела с facts — не трогаем');
  assert.equal(placeFacts(body, sections, null), body);

  // Описание модуля: поле, которого нет у услуги раздела, — сервер не стартует.
  const bad = (facts) => () => validateModule({ ...DEFAULT_MODULES[0], draft: DEFAULT_MODULES[0].draft.map((d) => (d.id === 'v_object' ? { ...d, facts } : d)) });
  assert.throws(bad(['area']), /facts — поля area нет у услуги раздела/);
  assert.throws(bad([]), /facts — непустой список/);
  assert.throws(bad(['color', 'color']), /facts — непустой список/);
  bad(['color', 'mileage'])();
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', bank: 'sber', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
  vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 120000 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005201');
  dispatcher = await login(S, '+79990005202');
  spec = await login(S, '+79990005203');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

test('поля заявки необязательны и проверяются; строка — в черновике от ИИ и в запросе модели', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Машина: сведения' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  // Без новых полей заявка отправляется, как раньше.
  assert.equal((await patch(BASE)).status, 200);
  for (const wrong of [{ gearbox: 'turbo' }, { drive: 'all' }, { accidents: 'maybe' }, { owner_kind: 'state' }, { engine_cc: 0 }, { engine_hp: 1.5 }, { book_value: -1 }, { color: 'x'.repeat(51) }]) {
    const r = await patch({ ...BASE, ...wrong });
    assert.equal(r.status, 400, JSON.stringify(wrong));
  }
  { const r = await patch({ ...BASE, ...ALL }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE);
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.ok(prompt.includes(LINE));
  assert.ok(prompt.includes('Балансовая стоимость, руб.: 1250000'), 'сами поля — в сведениях заявки');
});
