// Задача 2.531 (жилой дом): таблица «Стоимость дома и участка» в конец «14. Согласование результатов» черновика — дом,
// участок (в собственности), итог и доля участка; в аренде — право аренды участка; не оформлен — только дом; в деле — для
// кнопки «Вставить»; в Word. Номера +7 999 000-59-20…22 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { HOUSE_HEAD, houseTable, placeHouse } from '../../src/orders/house.mjs';
import { SHARE_HEAD } from '../../src/orders/share.mjs';
import { createRegistry, validateModule, DEFAULT_MODULES } from '../../src/modules/index.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

test('таблица по участку из заявки; место — в конце раздела; описание модуля проверяет флаг', () => {
  const own = houseTable('realty', { object_type: 'house', house_land: 'own', land_cadastral: '50:20:0010101:15', land_area: 12.5 });
  assert.deepEqual(own, [
    HOUSE_HEAD,
    '| Жилой дом, руб. | [заполнить] |',
    '| Земельный участок под домом (кадастровый номер 50:20:0010101:15, 12,5 сот. — по заявке, сверьте с выпиской ЕГРН на участок), руб. | [заполнить] |',
    '| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | [заполнить] |',
    '| Доля участка в итоговой стоимости, % | [заполнить] |',
  ]);
  assert.ok(houseTable('realty', { object_type: 'house', house_land: 'own' }).includes('| Земельный участок под домом, руб. | [заполнить] |'), 'без номера и площади — без скобок');
  const lease = houseTable('realty', { object_type: 'house', house_land: 'lease', land_area: 6 });
  assert.ok(lease.includes('| Право аренды участка под домом (6 сот. — по заявке, сверьте с выпиской ЕГРН на участок), руб. | [заполнить] (если переходит вместе с домом; иначе — «не оценивается») |'));
  assert.ok(lease.includes('| Итого: дом и право аренды участка, руб. | [заполнить] |'));
  const none = houseTable('realty', { object_type: 'house', house_land: 'none', land_area: 6 });
  assert.deepEqual(none, [HOUSE_HEAD, '| Жилой дом, руб. | [заполнить] |', '| Земельный участок | не оценивается — участок под домом не оформлен |', '| Итого (равно стоимости дома), руб. | [заполнить] |'], 'не оформлен — только дом');
  const ask = houseTable('realty', { object_type: 'house' });
  assert.match(ask.join('\n'), /оформлен ли участок — уточните у заказчика/);
  assert.equal(houseTable('realty', { object_type: 'flat', house_land: 'own' }), null, 'не дом — таблицы нет');
  assert.equal(houseTable('vehicle', { object_type: 'house' }), null);

  const registry = createRegistry();
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.house);
  assert.equal(sec.id, 'r_result');
  assert.equal(registry.draftSections('expertise', 'vehicle').some((s) => s.house), false);

  const sections = [{ title: '14. Согласование результатов и итоговая величина', share: true, house: true }, { title: '15. Литература' }];
  const body = '## 14. Согласование результатов и итоговая величина\n| Подход | Вес |\n| Сравнительный | 1 |\nИтог — [заполнить].\n## 15. Литература\nТекст.';
  const placed = placeHouse(body, sections, own);
  assert.equal(placed, `## 14. Согласование результатов и итоговая величина\n| Подход | Вес |\n| Сравнительный | 1 |\nИтог — [заполнить].\n\n${own.join('\n')}\n\n## 15. Литература\nТекст.`);
  assert.equal(placeHouse(placed, sections, none), placed.replace(own.join('\n'), none.join('\n')), 'прежняя заменена');
  assert.equal(placeHouse(body, sections, null), body);

  const bad = (house, id = 'r_result') => () => validateModule({ ...DEFAULT_MODULES[0], draft: DEFAULT_MODULES[0].draft.map((d) => (d.id === id ? { ...d, house } : d)) });
  assert.throws(bad('yes'), /house — только true/);
  assert.throws(bad(true, 'v_result'), /house — у услуги раздела нет поля house_land/);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Садовая, д. 7', area: 120,
  house_land: 'own', land_cadastral: '50:20:0010101:15', land_area: 12 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005920');
  dispatcher = await login(S, '+79990005921');
  spec = await login(S, '+79990005922');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('таблица — в черновике от ИИ и в запросе модели; в деле — по заявке сейчас; в Word', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дом: стоимость' })).body.order;
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
  const h = lines.findIndex((l) => /^#{1,3}\s*14\. Согласование результатов/.test(l));
  const t = lines.indexOf(HOUSE_HEAD);
  const next = lines.findIndex((l, i) => i > h && /^#{1,3}\s/.test(l));
  assert.ok(h >= 0 && t > h && (next < 0 || t < next), r.body.draft.body.slice(-1500));
  assert.equal(lines[t - 1], '');
  assert.equal(lines[t + 3], '| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | [заполнить] |');
  assert.equal(lines.filter((l) => l === HOUSE_HEAD).length, 1);
  assert.ok(!lines.includes(SHARE_HEAD), 'дом — не доля');
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.ok(prompt.includes('СТОИМОСТЬ ДОМА И УЧАСТКА'));
  assert.ok(prompt.includes('кадастровый номер 50:20:0010101:15, 12 сот.'));

  let g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.equal(g.body.house.join('\n'), lines.slice(t, t + 5).join('\n'));
  const og = await owner.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(og.status !== 200 || !og.body.house, 'заказчику таблицы нет');
  await S.sql`update orders set fields = fields || '{"house_land":"none"}'::jsonb where id = ${o.id}`;
  g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(g.body.house.includes('| Земельный участок | не оценивается — участок под домом не оформлен |'));

  const d = r.body.draft;
  const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, '1 000 000');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const text = (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  assert.ok(text.includes('Стоимость дома и участка'), text.slice(-800));
  assert.ok(text.includes('Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб.'));
  assert.ok(!text.includes('| Жилой дом, руб. |'), 'таблицей, а не строкой с чертами');
});
