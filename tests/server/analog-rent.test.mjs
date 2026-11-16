// Задача 2.523 (аналоги для нежилого): у аналога нежилого помещения — «Продажа или аренда». Аналоги аренды (цена — плата
// в месяц) в сравнительный подход не идут: не в счёт «не меньше трёх», не в таблицу сравнительного подхода в Word, цены с
// продажами не сравниваются; ставка за кв. м в месяц у аналога, средняя — строкой над списком и подсказкой к таблице
// доходного подхода в черновике. У других заявок признака нет. Номера +7 999 000-55-96…98 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { analogWarnings, analogTable, analogsBrief, rentSummary, rentRate } from '../../src/analogs/analogs.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

const reg = createRegistry();
const COMM = { region: 'moscow', object_type: 'commercial', area: 120 };
const spec = reg.analogs('expertise', 'realty', COMM);
const an = (id, deal, price, area = 100, extra = {}) => ({
  id, url: `https://www.cian.ru/rent/commercial/${id}/`, file_key: 'k', confirmed_at: new Date(),
  fields: { price_rub: price, listed_on: todayMsk(), region: 'moscow', address: 'Москва', area, ...(deal ? { deal } : {}) }, adjustments: [], ...extra,
});

test('признак «Продажа или аренда» — только у нежилого; ставка за кв. м в месяц', () => {
  assert.ok(spec.fields.some((f) => f.id === 'deal' && f.type === 'select'));
  for (const fields of [{ object_type: 'flat' }, { object_type: 'share' }, null]) {
    assert.ok(!reg.analogs('expertise', 'realty', fields).fields.some((f) => f.id === 'deal'));
  }
  assert.ok(!reg.analogs('expertise', 'land', COMM).fields.some((f) => f.id === 'deal'));
  assert.equal(rentRate(an(1, 'rent', 150_000, 100)), 1500);
  assert.equal(rentRate(an(1, 'rent', 150_000, null)), null);
  assert.equal(rentRate(an(1, 'sale', 150_000, 100)), null);
});

test('аналоги аренды не в счёт и с продажами не сравниваются; средняя ставка — строкой', () => {
  const list = [an(1, 'sale', 30_000_000), an(2, 'sale', 31_000_000), an(3, 'rent', 150_000, 100), an(4, 'rent', 200_000, 100), an(5, null, 29_000_000), an(6, 'rent', 170_000, null)];
  const { per, hints, confirmed, min } = analogWarnings(spec, { fields: COMM }, list);
  assert.equal(min, 3);
  assert.equal(confirmed, 3, 'продажи и неотмеченный, без аренды');
  assert.ok(!hints.some((h) => h.startsWith('Нужно не меньше')));
  // Цена аренды «сильно отличается» от продаж — не говорим: сравниваются только аналоги того же вида.
  for (const id of [1, 2, 3, 4]) assert.ok(!per.get(id).some((w) => /Цена сильно отличается/.test(w)), String(id));
  assert.ok(per.get(5).includes('Отметьте: продажа или аренда — аналоги аренды в сравнительный подход не идут'));
  assert.ok(per.get(6).includes('Аналог аренды: укажите площадь — ставка считается за кв. м в месяц'));
  assert.ok(hints.includes('Аналоги аренды 3, 4, 6 — в сравнительный подход не идут. Средняя ставка аренды аналогов 3, 4 — 1 750 руб. за кв. м в месяц (21 000 руб. за кв. м в год) — для строки «Рыночная ставка аренды» в таблице доходного подхода (× 12 — за год)'), hints.join('\n'));
  // Продаж меньше трёх — в подсказке сказано, что аренда не в счёт.
  const few = analogWarnings(spec, { fields: COMM }, [an(1, 'sale', 30_000_000), an(2, 'rent', 150_000)]);
  assert.ok(few.hints.includes('Нужно не меньше 3 аналогов продажи — подтверждено 1 (аналоги аренды не в счёт)'), few.hints.join('\n'));
  // Неподтверждённый аналог аренды — не в средней.
  assert.equal(rentSummary(spec, [an(1, 'rent', 100_000, 100, { confirmed_at: null }), an(2, 'rent', 120_000, 100)]).nums.join(), '2');
  // У квартиры — ни признака, ни слова об аренде.
  const flat = reg.analogs('expertise', 'realty', { object_type: 'flat' });
  const f = analogWarnings(flat, { fields: { object_type: 'flat' } }, [an(1, null, 9e6), an(2, null, 9e6), an(3, null, 9e6)]);
  assert.ok(![...f.per.values()].flat().some((w) => /аренд/i.test(w)) && !f.hints.some((h) => /аренд/i.test(h)));
  assert.equal(rentSummary(flat, [an(1, 'rent', 1, 1)]), null);
});

test('в Word: сравнительный подход — без аренды, аренда — своей таблицей с общими номерами и средней ставкой', () => {
  const list = [an(1, 'sale', 30_000_000), an(2, 'rent', 150_000, 100), an(3, 'sale', 31_000_000), an(4, 'rent', 200_000, 100)];
  const t = analogTable(spec, list, { fields: COMM });
  const at = t.indexOf('Аналоги аренды (для доходного подхода; в сравнительный подход не идут):');
  assert.ok(at > 0, t.join('\n'));
  const sale = t.slice(0, at).join('\n');
  assert.ok(!/Продажа или аренда/.test(sale), 'столбца «продажа или аренда» нет');
  assert.match(sale, /^\| 1 \|/m);
  assert.match(sale, /^\| 3 \|/m);
  assert.doesNotMatch(sale, /^\| [24] \|/m);
  assert.equal(t[at + 1], '| № | Источник | Плата в месяц, руб. | Площадь, кв. м | Ставка, руб. за кв. м в месяц | Регион |');
  assert.match(t[at + 2], /^\| 2 \| cian\.ru, от .+ \| 150 000 \| 100 \| 1 500 \| Москва \|$/);
  assert.equal(t.at(-1), 'Средняя ставка аренды аналогов 2, 4 — 1 750 руб. за кв. м в месяц (21 000 руб. за кв. м в год).');
  // Только аренда — сказано, что продаж нет.
  assert.equal(analogTable(spec, [an(1, 'rent', 1000, 10)], { fields: COMM })[0], 'Подтверждённых аналогов продажи нет.');
  // Для черновика от ИИ — аренда помечена.
  assert.match(analogsBrief(spec, list, { fields: COMM }), /Аналог 2: .*аренда — в сравнительный подход не идёт, только для доходного подхода; ставка — 1 500 руб\. за кв\. м в месяц/);
});

let S, owner, dispatcher, expert;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005596');
  dispatcher = await login(S, '+79990005597');
  expert = await login(S, '+79990005598');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, expert.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

const BASE = { purpose: 'bank', bank: 'other', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 1', area: 120, premises_use: 'office', lease: 'no' };

async function addAnalog(o, n, fields) {
  const r = await expert.req('POST', `/api/orders/${o.id}/analogs`, { url: `https://www.cian.ru/rent/commercial/5596${n}/` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${r.body.id}`, { fields: { listed_on: todayMsk(), region: 'moscow', address: `Москва, ${n}`, area: 100, ...fields } });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  // Подтверждение требует скриншота — здесь не о нём: отмечаем подтверждённым прямо в базе.
  await S.sql`update order_analogs set confirmed_at = now() where id = ${r.body.id}`;
  return (await expert.req('GET', `/api/orders/${o.id}/analogs`)).body;
}

test('в деле: ставка у аналога, строка над списком, подсказка к доходному подходу в черновике, Word', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Нежилое: аналоги аренды' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: BASE })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: expert.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await expert.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  await addAnalog(o, 1, { deal: 'sale', price_rub: 30_000_000 });
  await addAnalog(o, 2, { deal: 'rent', price_rub: 150_000 });
  let v = await addAnalog(o, 3, { deal: 'rent', price_rub: 200_000 });
  assert.ok(v.fields.some((f) => f.id === 'deal'));
  assert.equal(v.analogs[1].rent_rate, 1500);
  assert.equal(v.analogs[0].rent_rate, null);
  assert.equal(v.confirmed, 1);
  assert.ok(v.hints.some((h) => h.startsWith('Аналоги аренды 2, 3 — в сравнительный подход не идут. Средняя ставка аренды аналогов 2, 3 — 1 750')), v.hints.join('\n'));
  // Неверное значение — отказ.
  const bad = await expert.req('PUT', `/api/orders/${o.id}/analogs/${v.analogs[2].id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'moscow', address: 'x', deal: 'swap' } });
  assert.equal(bad.status, 400);

  const r = await expert.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.match(prompt, /аренда — в сравнительный подход не идёт/);
  const g = await expert.req('GET', `/api/orders/${o.id}/draft`);
  assert.deepEqual(g.body.income_rent, { nums: [2, 3], month: 1750, year: 21000 });
  const og = await owner.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(og.status !== 200 || !og.body.income_rent, 'заказчику подсказки нет');

  // Word: аналоги аренды своей таблицей.
  const d = r.body.draft;
  const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, '1 000 000');
  assert.equal((await expert.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: expert.cookie } });
  assert.equal(w.status, 200);
  const text = (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  assert.ok(text.includes('Аналоги аренды (для доходного подхода; в сравнительный подход не идут)'), text.slice(-1500));
  assert.ok(text.includes('Средняя ставка аренды аналогов 2, 3'));

  // Доходный подход не применяется — подсказки к нему нет.
  assert.equal((await expert.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: ['comparative'] })).status, 200);
  assert.equal((await expert.req('GET', `/api/orders/${o.id}/draft`)).body.income_rent, null);
});
