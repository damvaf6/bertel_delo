// Задача 2.521 (нежилое помещение): таблица «Расчёт доходным подходом» в конец «13. Доходный подход» черновика — площадь и
// арендная плата по договору из заявки, рыночная ставка, ПВД, недозагрузка, ДВД, расходы, ЧОД, ставка капитализации и
// стоимость — суммы «[заполнить]»; в деле — для кнопки «Вставить»; в Word. Номера +7 999 000-55-91…93 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { INCOME_HEAD, incomeTable, placeIncome } from '../../src/orders/income.mjs';
import { SHARE_HEAD } from '../../src/orders/share.mjs';
import { createRegistry, validateModule, DEFAULT_MODULES } from '../../src/modules/index.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

test('таблица у нежилого; площадь и плата из заявки; место — в конце раздела; описание модуля проверяет флаг', () => {
  const leased = incomeTable('realty', { object_type: 'commercial', area: 120.5, lease: 'full', lease_rent: 180000 });
  assert.deepEqual(leased, [
    INCOME_HEAD,
    '| Площадь помещения, кв. м | 120,5 (по заявке — сверьте с выпиской ЕГРН) |',
    '| Арендная плата по договору, руб. в месяц | 180 000 (по заявке — сравните с рыночной ставкой) |',
    '| Рыночная ставка аренды, руб. за кв. м в год | [заполнить] (аналоги аренды или источник — [заполнить]) |',
    '| Потенциальный валовой доход (площадь × ставка), руб. в год | [заполнить] |',
    '| Недозагрузка и потери при сборе платежей, % | [заполнить] (источник — [заполнить]) |',
    '| Действительный валовой доход (ПВД × (1 − недозагрузка)), руб. в год | [заполнить] |',
    '| Операционные расходы, руб. в год | [заполнить] (из чего состоят — [заполнить]) |',
    '| Чистый операционный доход (ДВД − расходы), руб. в год | [заполнить] |',
    '| Ставка капитализации, % | [заполнить] (источник — [заполнить]) |',
    '| Стоимость доходным подходом (ЧОД / ставка), руб. | [заполнить] |',
  ]);
  const free = incomeTable('realty', { object_type: 'commercial', lease: 'no', lease_rent: 50000 });
  assert.equal(free.length, 10, 'не сдаётся — строки о плате по договору нет');
  assert.ok(free.includes('| Площадь помещения, кв. м | [заполнить] |'), 'площади нет — пропуск');
  assert.equal(incomeTable('realty', { object_type: 'commercial', lease: 'part' }).length, 10, 'платы нет — строки нет');
  assert.equal(incomeTable('realty', { object_type: 'flat', lease: 'full', lease_rent: 1 }), null, 'не нежилое — таблицы нет');
  assert.equal(incomeTable('vehicle', { object_type: 'commercial' }), null);

  const registry = createRegistry();
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.income);
  assert.equal(sec.id, 'r_income');
  assert.equal(registry.draftSections('expertise', 'land').some((s) => s.income), false);

  const sections = [{ title: '13. Доходный подход', income: true }, { title: '14. Согласование результатов и итоговая величина', share: true }];
  const body = '## 13. Доходный подход\nМетод — прямая капитализация.\n## 14. Согласование результатов и итоговая величина\nТекст.';
  const placed = placeIncome(body, sections, leased);
  assert.equal(placed, `## 13. Доходный подход\nМетод — прямая капитализация.\n\n${leased.join('\n')}\n\n## 14. Согласование результатов и итоговая величина\nТекст.`);
  assert.equal(placeIncome(placed, sections, free), placed.replace(leased.join('\n'), free.join('\n')), 'прежняя заменена');
  assert.equal(placeIncome(body, sections, null), body);
  assert.equal(placeIncome(body, [{ title: '14. Согласование результатов и итоговая величина', share: true }], leased), body, 'раздела с income нет — как есть');

  const bad = (income, id = 'r_income') => () => validateModule({ ...DEFAULT_MODULES[0], draft: DEFAULT_MODULES[0].draft.map((d) => (d.id === id ? { ...d, income } : d)) });
  assert.throws(bad('yes'), /income — только true/);
  assert.throws(bad(true, 'v_result'), /income — у услуги раздела нет поля lease/);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', bank: 'other', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 1', area: 120.5, premises_use: 'office', lease: 'full', lease_rent: 180000 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005591');
  dispatcher = await login(S, '+79990005592');
  spec = await login(S, '+79990005593');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('таблица — в черновике от ИИ и в запросе модели; в деле — по заявке сейчас; в Word; без доходного подхода — нет', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Нежилое: доходный' })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: BASE });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*\d+\. Доходный подход/.test(l));
  const t = lines.indexOf(INCOME_HEAD);
  const next = lines.findIndex((l, i) => i > h && /^#{1,3}\s/.test(l));
  assert.ok(h >= 0 && t > h && (next < 0 || t < next), r.body.draft.body.slice(-2500));
  assert.equal(lines[t - 1], '');
  assert.equal(lines[t + 2], '| Арендная плата по договору, руб. в месяц | 180 000 (по заявке — сравните с рыночной ставкой) |');
  assert.equal(lines.filter((l) => l === INCOME_HEAD).length, 1);
  assert.equal(lines.includes(SHARE_HEAD), false, 'не доля — таблицы доли нет');
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.ok(prompt.includes('РАСЧЁТ ДОХОДНЫМ ПОДХОДОМ'));

  let g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.equal(g.body.income.join('\n'), lines.slice(t, t + 11).join('\n'));
  const og = await owner.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(og.status !== 200 || !og.body.income, 'заказчику таблицы нет');

  // Word собирается, таблица в нём.
  const d = r.body.draft;
  const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, '1 000 000');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const text = (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  assert.ok(text.includes('Расчёт доходным подходом'), text.slice(-800));
  assert.ok(text.includes('Чистый операционный доход (ДВД − расходы), руб. в год'));

  // Доходный подход не выбран — раздела и таблицы нет.
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: ['comparative'] })).status, 200);
  g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.equal(g.body.income, null);
});
