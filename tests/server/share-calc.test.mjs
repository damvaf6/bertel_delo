// Задача 2.511 (оценка доли): таблица «Расчёт стоимости доли» в конец «14. Согласование результатов» черновика — стоимость
// объекта целиком, размер доли, часть стоимости, скидка на долю (при «рыночной» — с источником, при «части целого» — не
// применяется), стоимость доли; в деле — для кнопки «Вставить»; в Word. Номера +7 999 000-54-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { SHARE_HEAD, shareTable, placeShare } from '../../src/orders/share.mjs';
import { createRegistry, validateModule, DEFAULT_MODULES } from '../../src/modules/index.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

test('таблица по способу из заявки; место — в конце раздела; описание модуля проверяет флаг', () => {
  const market = shareTable('realty', { object_type: 'share', share_size: '1/3', share_method: 'market' });
  assert.deepEqual(market, [
    SHARE_HEAD,
    '| Стоимость объекта целиком, руб. | [заполнить] |',
    '| Размер доли | 1/3 |',
    '| Часть стоимости объекта (целое × 1/3), руб. | [заполнить] |',
    '| Скидка на долю, % | [заполнить] (источник — [заполнить]) |',
    '| Рыночная стоимость доли (часть × (1 − скидка)), руб. | [заполнить] |',
  ]);
  const pro = shareTable('realty', { object_type: 'share', share_size: '1/2', share_method: 'pro_rata' });
  assert.ok(pro.includes('| Скидка на долю | не применяется — оценивается часть стоимости всего объекта |'));
  assert.ok(pro.includes('| Стоимость доли (равна части стоимости объекта), руб. | [заполнить] |'));
  const ask = shareTable('realty', { object_type: 'share', share_size: 'половина' });
  assert.ok(ask.includes('| Размер доли | [заполнить] |'), 'размер не дробью — пропуск');
  assert.ok(ask.includes('| Часть стоимости объекта (целое × доля), руб. | [заполнить] |'));
  assert.match(ask.join('\n'), /со скидкой или без — по заданию на оценку или определению суда/);
  assert.equal(shareTable('realty', { object_type: 'flat', share_size: '1/3' }), null, 'не доля — таблицы нет');
  assert.equal(shareTable('vehicle', { object_type: 'share' }), null);

  const registry = createRegistry();
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.share);
  assert.equal(sec.id, 'r_result');
  assert.equal(registry.draftSections('expertise', 'vehicle').some((s) => s.share), false);

  // Место: в конец раздела, после таблицы весов, через пустую строку; прежняя заменяется целиком.
  const sections = [{ title: '14. Согласование результатов и итоговая величина', share: true }, { title: '15. Литература' }];
  const body = '## 14. Согласование результатов и итоговая величина\n| Подход | Вес |\n| Сравнительный | 1 |\nИтог — [заполнить].\n## 15. Литература\nТекст.';
  const placed = placeShare(body, sections, market);
  assert.equal(placed, `## 14. Согласование результатов и итоговая величина\n| Подход | Вес |\n| Сравнительный | 1 |\nИтог — [заполнить].\n\n${market.join('\n')}\n\n## 15. Литература\nТекст.`);
  assert.equal(placeShare(placed, sections, pro), placed.replace(market.join('\n'), pro.join('\n')), 'прежняя заменена');
  const last = placeShare('## 14. Согласование результатов и итоговая величина\nИтог.', sections, pro);
  assert.equal(last, `## 14. Согласование результатов и итоговая величина\nИтог.\n\n${pro.join('\n')}\n`, 'последний раздел — в конец текста');
  assert.equal(placeShare(body, sections, null), body);
  assert.equal(placeShare('Без заголовков.', sections, pro), 'Без заголовков.');

  const bad = (share, id = 'r_result') => () => validateModule({ ...DEFAULT_MODULES[0], draft: DEFAULT_MODULES[0].draft.map((d) => (d.id === id ? { ...d, share } : d)) });
  assert.throws(bad('yes'), /share — только true/);
  assert.throws(bad(true, 'v_result'), /share — у услуги раздела нет поля share_size/);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'division', region: 'moscow', object_type: 'share', address: 'г. Москва, Тестовая ул., д. 1, кв. 3', area: 54, share_size: '1/3', share_method: 'market' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005411');
  dispatcher = await login(S, '+79990005412');
  spec = await login(S, '+79990005413');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('таблица — в черновике от ИИ и в запросе модели; в деле — по заявке сейчас; в Word', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Доля: расчёт' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: BASE })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const body = r.body.draft.body;
  const lines = body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*14\. Согласование результатов/.test(l));
  const t = lines.indexOf(SHARE_HEAD);
  const next = lines.findIndex((l, i) => i > h && /^#{1,3}\s/.test(l));
  assert.ok(h >= 0 && t > h && (next < 0 || t < next), body.slice(-1500));
  assert.equal(lines[t - 1], '', 'через пустую строку от текста и таблицы весов');
  assert.equal(lines[t + 5], '| Рыночная стоимость доли (часть × (1 − скидка)), руб. | [заполнить] |');
  assert.equal(lines.filter((l) => l === SHARE_HEAD).length, 1);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.ok(prompt.includes('РАСЧЁТ СТОИМОСТИ ДОЛИ'));
  assert.ok(prompt.includes('| Размер доли | 1/3 |'));

  // В деле: исполнителю — таблица по заявке сейчас; заказчику — нет. Способ поменяли — другая таблица.
  let g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.equal(g.body.share.join('\n'), lines.slice(t, t + 6).join('\n'));
  const og = await owner.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(og.status !== 200 || !og.body.share, 'заказчику таблицы нет');
  await S.sql`update orders set fields = fields || '{"share_method":"pro_rata"}'::jsonb where id = ${o.id}`;
  g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(g.body.share.includes('| Скидка на долю | не применяется — оценивается часть стоимости всего объекта |'));

  // Word собирается, таблица в нём.
  const d = r.body.draft;
  const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, '1 000 000');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const text = (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  assert.ok(text.includes('Расчёт стоимости доли'), text.slice(-800));
  assert.ok(text.includes('Часть стоимости объекта (целое × 1/3), руб.'));
  assert.ok(!text.includes('| Размер доли |'), 'таблицей, а не строкой с чертами');
});
