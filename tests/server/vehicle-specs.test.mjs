// Задача 2.494 (оценка транспорта): таблица «Характеристики объекта оценки» в раздел «7. Описание объекта» — марка, модель,
// год, VIN, госномер, пробег по прибору, состояние по осмотру — из заявки и выезда помощника; в черновик и Word.
// Номера +7 999 000-52-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { SPECS_HEAD, specsTable, placeSpecs } from '../../src/orders/specs.mjs';
import { FACTS_HEAD } from '../../src/orders/facts.mjs';
import { createRegistry, validateModule, DEFAULT_MODULES } from '../../src/modules/index.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

const BASE = { purpose: 'bank', bank: 'sber', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
  vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 120000 };
const dayRu = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

test('таблица из заявки и выезда; место в разделе; описание модуля проверяет строки', () => {
  const registry = createRegistry();
  const fields = registry.service('expertise', 'vehicle').fields;
  const ex = registry.express('expertise', 'vehicle').fields;
  const sec = registry.draftSections('expertise', 'vehicle').find((s) => s.specs);
  assert.equal(sec.id, 'v_object');
  assert.equal(registry.draftSections('expertise', 'realty').some((s) => s.specs), false);

  // Без выезда: строк «с выезда» нет, пробег — по заявке.
  assert.deepEqual(specsTable(sec.specs, fields, BASE, ex, null), [
    SPECS_HEAD,
    '| Вид транспорта | Легковой автомобиль | заявка |',
    '| Марка и модель | Тестовая Модель | заявка |',
    '| Год выпуска | 2020 | заявка |',
    '| VIN | XTA00000000000001 | заявка |',
    '| Госномер | А001АА777 | заявка |',
    '| Пробег | 120 000 км | заявка |',
  ]);
  // Пусто в заявке — пропуск для эксперта.
  const gaps = specsTable(sec.specs, fields, { make_model: 'Модель' }, ex, null);
  assert.ok(gaps.includes('| Год выпуска | [заполнить] | — |'));
  assert.ok(gaps.includes('| Пробег | [заполнить] | — |'));
  assert.equal(specsTable(sec.specs, fields, {}, ex, null), null, 'ничего нет — таблицы нет');

  // С выезда: пробег по прибору (в заявке другой — в скобках), VIN на кузове и состояние.
  const at = new Date('2026-11-12T09:00:00Z');
  const t = specsTable(sec.specs, fields, BASE, ex, { finished_at: at, data: { mileage: 190000, vin_match: 'no', condition: 'needs_repair' } });
  assert.ok(t.includes(`| Пробег | 190 000 км (в заявке — 120 000 км) | по осмотру, выезд помощника ${dayRu(at)} |`), t.join('\n'));
  assert.ok(t.includes(`| VIN на кузове совпадает с документами | Нет | по осмотру, выезд помощника ${dayRu(at)} |`));
  assert.ok(t.includes(`| Состояние по осмотру | Нужен ремонт | по осмотру, выезд помощника ${dayRu(at)} |`));
  const same = specsTable(sec.specs, fields, BASE, ex, { finished_at: at, data: { mileage: 120000 } });
  assert.ok(same.includes(`| Пробег | 120 000 км | по осмотру, выезд помощника ${dayRu(at)} |`), 'совпало — без скобок');
  assert.ok(same.includes('| Состояние по осмотру | [заполнить] | — |'), 'выезд был, а состояние не записано — пропуск');

  // Место: под заголовком раздела, прежняя таблица заменяется целиком; «|» из значения не ломает таблицу.
  const sections = [{ title: '6. Сведения об оценщике' }, { title: '7. Описание объекта оценки', specs: sec.specs }];
  const body = '## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\nЛегковой автомобиль.';
  const placed = placeSpecs(body, sections, t);
  assert.equal(placed, `## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\n${t.join('\n')}\nЛегковой автомобиль.`);
  const t2 = specsTable(sec.specs, fields, { ...BASE, make_model: 'A|B' }, ex, null);
  assert.ok(t2.includes('| Марка и модель | A/B | заявка |'));
  assert.equal(placeSpecs(placed, sections, t2), body.replace('оценки\n', `оценки\n${t2.join('\n')}\n`), 'прежняя заменена');
  assert.equal(placeSpecs(body, sections, null), body);

  // Описание модуля: неизвестное поле, поле выезда не той услуги, пустая строка — сервер не стартует.
  const bad = (specs) => () => validateModule({ ...DEFAULT_MODULES[0], draft: DEFAULT_MODULES[0].draft.map((d) => (d.id === 'v_object' ? { ...d, specs } : d)) });
  assert.throws(bad([{ field: 'area' }]), /specs — поля area нет у услуги раздела/);
  assert.throws(bad([{ onsite: 'area_measured' }]), /specs — поля area_measured нет в данных с объекта/);
  assert.throws(bad([{ onsite: 'nope' }]), /specs — поля nope нет/);
  assert.throws(bad([{}]), /specs — у строки field или onsite/);
  assert.throws(bad([]), /specs — непустой список/);
  assert.throws(bad([{ field: 'vin', extra: 1 }]), /extra/);
  bad([{ field: 'vin' }, { onsite: 'condition' }])();
});

let S, owner, dispatcher, spec;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005211');
  dispatcher = await login(S, '+79990005212');
  spec = await login(S, '+79990005213');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

test('таблица — в черновике от ИИ и в запросе модели; в деле — свежая таблица после выезда; в Word', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Машина: характеристики' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...BASE, color: 'белый' } })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0);
  assert.ok(lines[h + 1].startsWith(FACTS_HEAD), 'сначала строка «Из заявки»');
  assert.equal(lines[h + 2], SPECS_HEAD, 'потом таблица');
  assert.equal(lines[h + 8], '| Пробег | 120 000 км | заявка |');
  assert.equal(lines.filter((l) => l === SPECS_HEAD).length, 1);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.ok(prompt.includes('ХАРАКТЕРИСТИКИ ОБЪЕКТА ОЦЕНКИ'));
  assert.ok(prompt.includes('| Пробег | 120 000 км | заявка |'));

  // В деле: исполнителю — таблица сейчас; заказчику — нет.
  let g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.equal(g.body.specs.join('\n'), lines.slice(h + 2, h + 8 + 1).join('\n'));
  const og = await owner.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(og.status !== 200 || !og.body.specs, 'заказчику таблицы нет');
  // Выезд помощника завершён — в таблице пробег по прибору и состояние.
  const [v] = await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, data)
                          values (${o.id}, ${owner.user.id}, ${spec.user.id}, now(), ${JSON.stringify({ mileage: 190000, condition: 'good' })}) returning id`;
  g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(g.body.specs.includes('| Пробег | 120 000 км | заявка |'), 'выезд не завершён — как было');
  await S.sql`update onsite_visits set finished_at = now() where id = ${v.id}`;
  g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(g.body.specs.some((l) => l.startsWith('| Пробег | 190 000 км (в заявке — 120 000 км) | по осмотру, выезд помощника')));
  assert.ok(g.body.specs.some((l) => l.startsWith('| Состояние по осмотру | Хорошее | по осмотру')));
  await S.sql`update onsite_visits set cancelled_at = now() where id = ${v.id}`;
  g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(g.body.specs.includes('| Пробег | 120 000 км | заявка |'), 'отменённый выезд не в счёт');

  // Word собирается, таблица в нём.
  const d = r.body.draft;
  const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const text = (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  assert.ok(text.includes('Характеристика объекта оценки'), text.slice(0, 500));
  assert.ok(text.includes('XTA00000000000001'));
  assert.ok(!text.includes('| Пробег |'), 'таблицей, а не строкой с чертами');
});
