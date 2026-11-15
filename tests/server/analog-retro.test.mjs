// Задача 2.503 (аналоги при оценке задним числом): объявление позже даты оценки больше чем на 3 месяца — у аналога
// предупреждение «нужен архив объявлений на дату оценки или корректировка на дату» и строка над списком аналогов; «старше
// полугода» — от даты оценки, а не от сегодня. Дата оценки — задание на оценку или день открытия наследства из заявки.
// Номера +7 999 000-53-21…23 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { analogWarnings } from '../../src/analogs/analogs.mjs';

const reg = createRegistry();
const spec = reg.analogs('expertise', 'realty');
const order = { fields: { region: 'moscow' } };
const an = (id, listed_on, extra = {}) => ({ id, file_key: 'k', confirmed_at: new Date(), fields: { price_rub: 9_000_000, listed_on, region: 'moscow', ...extra.fields }, adjustments: extra.adjustments ?? [] });
const ru = (iso) => iso.split('-').reverse().join('.');

test('объявление позже даты оценки больше чем на 3 месяца — предупреждение и строка над списком', () => {
  const vd = addDays(todayMsk(), -200);
  const list = [an(1, addDays(vd, 10)), an(2, addDays(vd, 150)), an(3, addDays(todayMsk(), -5)), an(4, addDays(vd, 120), { adjustments: [{ kind: 'date', pct: -5, book: 'Справочник', year: 2026, table: '1' }] })];
  const { per, hints } = analogWarnings(spec, order, list, null, vd);
  const late = (id) => per.get(id).find((w) => /позже даты оценки/.test(w));
  assert.equal(late(1), undefined, 'в пределах 3 месяцев');
  assert.match(late(2), new RegExp(`^Объявление позже даты оценки \\(${ru(vd).replace(/\./g, '\\.')}\\) на [3-5] мес\\. — нужен архив объявлений на дату оценки или корректировка на дату$`));
  assert.ok(late(3), 'сегодняшнее объявление');
  assert.equal(late(4), undefined, 'есть корректировка «На дату оценки»');
  assert.equal(hints[0], `Оценка на прошлую дату (${ru(vd)}): объявления аналогов 2, 3 позже неё больше чем на 3 месяца — нужен архив объявлений на дату оценки или корректировка на дату`);
  // «Старше полугода» — от даты оценки: объявление на дату оценки не старое, хотя сегодня ему больше полугода.
  assert.ok(!per.get(1).some((w) => /старше полугода/.test(w)));
  const old = analogWarnings(spec, order, [an(5, addDays(vd, -200))], null, vd).per.get(5);
  assert.ok(old.includes(`Объявление старше полугода на дату оценки (${ru(vd)}) — нужна корректировка на дату или другой аналог`), old.join('\n'));
  // Без даты оценки — как раньше: от сегодня, о «позже даты оценки» молчим.
  const plain = analogWarnings(spec, order, list, null, null);
  assert.ok(plain.per.get(1).includes('Объявление старше полугода — нужна корректировка на дату или другой аналог'));
  assert.ok(!plain.hints.some((h) => /прошлую дату/.test(h)));
  assert.ok(![...plain.per.values()].flat().some((w) => /позже даты оценки/.test(w)));
  // Дата оценки сегодня или неправильная — не в счёт.
  assert.ok(!analogWarnings(spec, order, list, null, todayMsk()).hints.some((h) => /прошлую дату/.test(h)));
  assert.ok(!analogWarnings(spec, order, list, null, '03.06.2026').hints.some((h) => /прошлую дату/.test(h)));
  // Один аналог — «объявление аналога».
  assert.match(analogWarnings(spec, order, [an(7, todayMsk())], null, vd).hints[0], /: объявление аналога 1 позже неё/);
});

let S, owner, dispatcher, expert;
const BASE = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 4, кв. 5', area: 45 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005321');
  dispatcher = await login(S, '+79990005322');
  expert = await login(S, '+79990005323');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, expert.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function caseInWork(fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: аналоги задним числом' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: expert.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await expert.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  return o;
}

test('в деле для наследства: аналог с сегодняшним объявлением — предупреждение у аналога и строка над списком', async () => {
  const death = addDays(todayMsk(), -150);
  const o = await caseInWork({ ...BASE, death_date: ru(death) });
  let r = await expert.req('POST', `/api/orders/${o.id}/analogs`, { url: 'https://www.cian.ru/sale/flat/100500/' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await expert.req('PUT', `/api/orders/${o.id}/analogs/${r.body.id}`, { fields: { price_rub: 9_500_000, listed_on: todayMsk(), region: 'moscow' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.analogs[0];
  assert.ok(a.warnings.some((w) => w.startsWith(`Объявление позже даты оценки (${ru(death)}) на `)), a.warnings.join('\n'));
  assert.equal(r.body.hints[0], `Оценка на прошлую дату (${ru(death)}): объявление аналога 1 позже неё больше чем на 3 месяца — нужен архив объявлений на дату оценки или корректировка на дату`);
  // Диспетчер видит то же.
  const d = await dispatcher.req('GET', `/api/orders/${o.id}/analogs`);
  assert.equal(d.body.hints[0], r.body.hints[0]);
  // Цель не наследство — даты оценки нет, предупреждения нет.
  await S.sql`update orders set fields = fields || '{"purpose":"bank"}'::jsonb where id = ${o.id}`;
  const g = await expert.req('GET', `/api/orders/${o.id}/analogs`);
  assert.ok(!g.body.hints.some((h) => /прошлую дату/.test(h)));
});
