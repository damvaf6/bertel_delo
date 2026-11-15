// Задача 2.506 (несколько объектов наследства в одной заявке): поле «Если наследство — другие объекты в его составе» и «общая
// стоимость»; подсказка в деле, строка «Оценивается в составе наследства: …» в «Задание на оценку» черновика; ИИ-проверка —
// каждый объект назван и со своей стоимостью, общая — если просили, и равна сумме. Номера +7 999 000-53-41…44 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { heirObjects, heirLine, heirSet, inheritanceNotices, placeHeir } from '../../src/orders/inheritance.mjs';
import { runAutoChecks, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';

const today = '2026-11-15';
const HEIR = { purpose: 'inheritance', death_date: '03.06.2026', address: 'г. Москва, Тестовая ул., д. 1, кв. 1' };

test('объекты наследства: разбор, строка и подсказка', () => {
  assert.deepEqual(heirObjects({ heir_objects: '1. Гараж, ГСК «Ромашка», бокс 12;\n\n- Лада Веста, 2019\nгараж, гск «ромашка», бокс 12' }),
    ['Гараж, ГСК «Ромашка», бокс 12', 'Лада Веста, 2019'], 'без нумерации, маркеров, пустых и повторов');
  assert.equal(heirSet('realty', { ...HEIR }), null, 'других объектов нет — молчим');
  assert.equal(heirSet('realty', { ...HEIR, purpose: 'bank', heir_objects: 'Гараж' }), null, 'цель не наследство');
  assert.equal(heirSet('goods', { ...HEIR, heir_objects: 'Гараж' }), null, 'не оценка');
  const f = { ...HEIR, heir_objects: 'Гараж, ГСК «Ромашка», бокс 12\nЛада Веста, 2019' };
  assert.equal(heirLine('realty', f), 'Оценивается в составе наследства: 1) г. Москва, Тестовая ул., д. 1, кв. 1; 2) Гараж, ГСК «Ромашка», бокс 12; 3) Лада Веста, 2019. Рыночная стоимость определяется по каждому объекту отдельно.');
  assert.match(heirLine('realty', { ...f, heir_total: 'total' }), /по каждому объекту отдельно и общая — сумма стоимостей всех объектов\.$/);
  assert.match(heirLine('vehicle', { purpose: 'inheritance', make_model: 'Тойота Камри', year: 2018, heir_objects: 'Гараж' }), /^Оценивается в составе наследства: 1\) Тойота Камри, 2018; 2\) Гараж\./);
  assert.match(heirLine('realty', { ...f, share_size: '1/2' }), /1\) доля 1\/2, г\. Москва/);
  const n = inheritanceNotices('realty', f, today);
  assert.deepEqual(n.map((x) => x.id), ['inheritance_ok', 'inheritance_objects']);
  assert.equal(n[1].text, 'В составе наследства 3 объекта: г. Москва, Тестовая ул., д. 1, кв. 1; Гараж, ГСК «Ромашка», бокс 12; Лада Веста, 2019. В отчёте — стоимость каждого.');
  // В черновик — под заголовком «Задание на оценку»; второй раз — заменяется, не дублируется.
  const sections = [{ title: '1. Основные факты' }, { title: '2. Задание на оценку', table: 'task' }];
  const body = '## 1. Основные факты\nтекст\n## 2. Задание на оценку\n| Объект | квартира |';
  const once = placeHeir(body, sections, heirLine('realty', f));
  assert.ok(once.includes('## 2. Задание на оценку\nОценивается в составе наследства: 1)'), once);
  const twice = placeHeir(once, sections, heirLine('realty', { ...f, heir_total: 'total' }));
  assert.equal(twice.split('Оценивается в составе наследства:').length, 2);
  assert.ok(twice.includes('и общая — сумма'));
});

test('поля — у всех услуг оценки, необязательны', () => {
  const reg = createRegistry();
  for (const s of ['realty', 'land', 'vehicle', 'movable']) {
    const fields = reg.service('expertise', s).fields;
    for (const id of ['heir_objects', 'heir_total']) {
      const x = fields.find((y) => y.id === id);
      assert.ok(x && !x.required, `${s}: ${id}`);
    }
  }
  assert.equal(reg.service('expertise', 'goods').fields.some((x) => x.id === 'heir_objects'), false);
  assert.ok(reg.checks('expertise', 'realty').some((c) => (c.auto ?? []).includes('heir_objects')));
});

test('ИИ-проверка: каждый объект со своей стоимостью, общая — сумма', () => {
  assert.ok(AUTO_CHECKS.heir_objects);
  const f = { ...HEIR, heir_objects: 'Гараж, ГСК «Ромашка», бокс 12\nЛада Веста, 2019' };
  const doc = (lines) => ({ name: 'Отчёт.pdf', kind: 'pdf', pages: [['ОТЧЁТ ОБ ОЦЕНКЕ № 9', 'Дата оценки: 03.06.2026', ...lines].join('\n')] });
  const run = (lines, fields = f) => runAutoChecks(['heir_objects'], [doc(lines)], { service: 'realty', fields, today }).heir_objects;
  const good = ['Рыночная стоимость квартиры — 9 800 000 руб.', 'Рыночная стоимость гаража в ГСК «Ромашка», бокс 12 — 650 000 руб.',
    'Рыночная стоимость автомобиля Лада Веста 2019 г. в. — 700 000 руб.'];
  assert.deepEqual(run(good), []);
  assert.deepEqual(run(good, { ...HEIR }), [], 'одного объекта — молчим');
  assert.deepEqual(run(good.slice(0, 2), { ...HEIR, purpose: 'bank', heir_objects: 'Лада Веста, 2019' }), [], 'не наследство — молчим');
  // Машины в отчёте нет.
  const miss = run(good.slice(0, 2));
  assert.equal(miss.length, 1);
  assert.equal(miss[0].text, 'Объект из заявки «Лада Веста, 2019» в отчёте не найден: в составе наследства оценивается каждый объект — опишите его и укажите его рыночную стоимость');
  // Гараж назван, но без своей суммы.
  const bare = run(['Рыночная стоимость квартиры — 9 800 000 руб.', 'Гараж в ГСК «Ромашка», бокс 12, осмотрен 10.11.2026.', good[2]]);
  assert.equal(bare.length, 1);
  assert.match(bare[0].text, /^У объекта «Гараж, ГСК «Ромашка», бокс 12» в отчёте нет своей стоимости/);
  assert.equal(bare[0].quote, 'Гараж в ГСК «Ромашка», бокс 12, осмотрен 10.11.2026.');
  // Просили общую: нет её — находка; есть и сходится — молчим; не сходится — находка с суммой.
  const total = { ...f, heir_total: 'total' };
  assert.match(run(good, total)[0].text, /^Заказчик просил общую стоимость всех объектов наследства \(3\), а в отчёте её нет/);
  assert.deepEqual(run([...good, 'Общая рыночная стоимость объектов наследства — 11 150 000 руб.'], total), []);
  assert.deepEqual(run([...good, 'Итого: 11 150 000 руб.'], total), []);
  const odd = run([...good, 'Общая рыночная стоимость — 10 450 000 руб.'], total);
  assert.equal(odd.length, 1);
  assert.equal(odd[0].text, 'Общая стоимость 10 450 000 руб. не равна сумме по объектам 11 150 000 руб. (9 800 000 + 650 000 + 700 000) — пересчитайте');
});

let S, owner, dispatcher, spec, stranger;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005341');
  dispatcher = await login(S, '+79990005342');
  spec = await login(S, '+79990005343');
  stranger = await login(S, '+79990005344');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('заявка: объекты сохраняются, подсказка в деле, строка — в задании на оценку черновика', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира и гараж: наследство' })).body.order;
  const base = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 1, кв. 1', area: 45,
    death_date: addDays(todayMsk(), -90).split('-').reverse().join('.') };
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch({ ...base, heir_objects: 'x'.repeat(2001) })).status, 400);
  assert.equal((await patch({ ...base, heir_total: 'all' })).status, 400);
  const r0 = await patch({ ...base, heir_objects: 'Гараж, ГСК «Ромашка», бокс 12\nЛада Веста, 2019', heir_total: 'total' });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const view = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.deepEqual(view.notices.map((n) => n.id), ['inheritance_ok', 'inheritance_objects']);
  assert.match(view.notices[1].text, /В составе наследства 3 объекта: .*Гараж.*Лада Веста, 2019\. В отчёте — стоимость каждого и общая стоимость всех\./);
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}`)).status, 404, 'чужой не видит');

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const body = r.body.draft.body;
  const line = 'Оценивается в составе наследства: 1) г. Москва, Тестовая ул., д. 1, кв. 1; 2) Гараж, ГСК «Ромашка», бокс 12; 3) Лада Веста, 2019. Рыночная стоимость определяется по каждому объекту отдельно и общая — сумма стоимостей всех объектов.';
  assert.match(body, /#+\s*2\. Задание на оценку\nОценивается в составе наследства:/, body.slice(0, 2000));
  assert.ok(body.includes(line));
  assert.equal(body.split('Оценивается в составе наследства:').length, 2, 'одна строка');
});
