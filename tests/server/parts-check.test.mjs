// 2.472: ИИ-проверка заключения по ДТП — у каждой детали из таблицы повреждённых деталей дела есть фото осмотра и строка
// в калькуляции ремонта; деталь из заявки «Что повреждено» есть в исследовании повреждений. Находки — в пункте «Повреждения».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { damageItems, runAutoChecks } from '../../src/ai/report-checks.mjs';

const REPORT = [
  'ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 12',
  '5. Исследование повреждений ........ 4',
  '7. Расчёт стоимости восстановительного ремонта ........ 6',
  '3. Объект и обстоятельства ДТП',
  'Со слов владельца повреждены задний бампер, левая фара и крышка багажника.',
  '5. Исследование повреждений',
  '| 1 | Бампер задний | Разрыв | замена, окраска | Фото 9 |',
  '| 2 | Крышка багажника | Вмятина | ремонт, окраска | нет фото |',
  '6. Методика расчёта',
  'Методические рекомендации ФБУ РФЦСЭ (2018).',
  '7. Расчёт стоимости восстановительного ремонта',
  'Облицовка заднего бампера 52159-XXXX 18 500 руб.',
  'Окраска заднего бампера 6 200 руб.',
  '8. Утрата товарной стоимости',
  'Крышка багажника — УТС не считается.',
].join('\n');
const run = (text, parts, damage = 'Задний бампер, крышка багажника, левая фара') =>
  runAutoChecks(['parts_match'], [{ name: 'Заключение.docx', pages: [text] }], { service: 'car_damage', fields: { damage }, parts }).parts_match;

test('«Что повреждено» своими словами → детали со стороной', () => {
  assert.deepEqual(damageItems('Помят задний бампер, разбита левая фара и крышка багажника; царапины'), ['задний бампер', 'левая фара', 'крышка багажника']);
  assert.deepEqual(damageItems('Всё сзади помято'), []);
  assert.deepEqual(damageItems('Дверь пер. лев.\nПравое зеркало'), ['дверь пер лев', 'правое зеркало']);
});

test('правило: без фото, нет в калькуляции, деталь из заявки не исследована — находки; падежи и порядок слов не важны', () => {
  const parts = [{ part: 'Бампер задний', photos: [9] }, { part: 'Крышка багажника', photos: [] }];
  const f = run(REPORT, parts);
  assert.deepEqual(f.map((x) => x.text), [
    'Деталь «Крышка багажника» из таблицы повреждённых деталей — без фото осмотра: укажите в таблице номер фото или попросите доснять',
    'Деталь «Крышка багажника» есть в таблице повреждённых деталей, а в калькуляции ремонта её не нашлось — добавьте строку в калькуляцию или уберите деталь из таблицы',
    'В заявке «Что повреждено» указано «левая фара», а в исследовании повреждений этой детали нет — исследуйте её или напишите, почему повреждение не от этого ДТП',
  ]);
  // Место — строка таблицы, начало калькуляции, заголовок исследования (не оглавление и не пересказ заявки в разделе 3).
  assert.equal(f[0].quote, '| 2 | Крышка багажника | Вмятина | ремонт, окраска | нет фото |');
  assert.equal(f[1].quote, '7. Расчёт стоимости восстановительного ремонта');
  assert.equal(f[2].quote, '5. Исследование повреждений');
  assert.equal(f[2].where, 'стр. 1');
  // Всё на месте — без находок: фото есть, крышка в калькуляции, фара исследована (сокращения сторон — «лев.»).
  const ok = REPORT.replace('8. Утрата', 'Крышка багажника — ремонт 2,0 н/ч 4 000 руб.\n8. Утрата')
    .replace('| нет фото |', '| Фото 10 |').replace('6. Методика', 'Фара лев. — разбит рассеиватель, замена.\n6. Методика');
  assert.deepEqual(run(ok, [{ part: 'Бампер задний', photos: [9] }, { part: 'Крышка багажника', photos: [10] }]), []);
  // Задний бампер в таблице не заменяет передний из заявки.
  assert.match(run(ok, [{ part: 'Бампер задний', photos: [9] }], 'передний бампер')[0].text, /«передний бампер»/);
});

test('правило: калькуляции нет — одна находка; таблицы нет — сверка заявки с исследованием; не ДТП — молчим', () => {
  const noCalc = 'ЗАКЛЮЧЕНИЕ\n5. Исследование повреждений\nБампер задний — разрыв.\n9. Выводы\n';
  const f = run(noCalc, [{ part: 'Бампер задний', photos: [1] }], 'задний бампер');
  assert.equal(f.length, 1);
  assert.match(f[0].text, /^Калькуляции ремонта в отчёте не нашлось/);
  // Таблицу не загружали (null) — только «Что повреждено» против исследования.
  assert.deepEqual(run(noCalc, null, 'задний бампер'), []);
  assert.match(run(noCalc, null, 'капот')[0].text, /«капот»/);
  // Раздела «Исследование повреждений» нет — ищем по всему отчёту.
  assert.deepEqual(run('Повреждён капот, требуется ремонт', null, 'капот'), []);
  assert.deepEqual(runAutoChecks(['parts_match'], [{ name: 'a', pages: ['x'] }], { service: 'vehicle', fields: { damage: 'капот' }, parts: [] }).parts_match, []);
});

let S, owner, dispatcher, spec;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004721');
  dispatcher = await login(S, '+79990004722');
  spec = await login(S, '+79990004723');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'car_damage']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

test('ИИ-проверка дела по ДТП: находки по таблице деталей дела — в пункте «Повреждения», номера фото — текущие', async () => {
  const fields = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021,
    vin: 'XTA00000000000001', reg_number: 'А001АА777', accident_date: '14.09.2026', damage: 'Задний бампер, левая фара', method: 'market' };
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'car_damage', title: 'ДТП: проверка деталей' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const link = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const [d] = await S.sql`insert into documents (order_id, uploaded_by, kind, filename, mime, size_bytes, storage_key)
    values (${o.id}, ${spec.user.id}, 'inspection', 'close.jpg', 'image/jpeg', 10, ${`test/${o.id}/close`}) returning id`;
  await S.sql`insert into inspection_photos (document_id, link_id, step) values (${d.id}, ${link.body.link.id}, 'car_damage_close')`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/parts`, { part: 'Бампер задний', damage: 'Разрыв', actions: ['replace'], photos: [1] })).status, 201);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/parts`, { part: 'Крышка багажника', damage: 'Вмятина', actions: ['repair'], photos: [] })).status, 201);
  const text = '5. Исследование повреждений\nБампер задний — разрыв.\nКрышка багажника — вмятина.\n7. Расчёт стоимости восстановительного ремонта\nБампер задний 18 500 руб.\n9. Выводы\n';
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(text), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') },
  })).status, 201);
  const found = async () => {
    S.providers.ai.reset();
    const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
    assert.equal(ai.status, 201, JSON.stringify(ai.body));
    return (ai.body.ai.items.find((i) => i.id === 'cd_damage').found ?? []).map((f) => f.text);
  };
  const first = await found();
  assert.equal(first.length, 3, first.join('\n'));
  assert.match(first[0], /^Деталь «Крышка багажника» из таблицы повреждённых деталей — без фото осмотра/);
  assert.match(first[1], /^Деталь «Крышка багажника» есть в таблице .* в калькуляции ремонта её не нашлось/);
  assert.match(first[2], /«левая фара»/);
  // Фото удалили — у бампера тоже «без фото».
  await S.sql`update documents set deleted_at = now() where id = ${d.id}`;
  assert.ok((await found()).some((t) => /^Деталь «Бампер задний» из таблицы повреждённых деталей — без фото/.test(t)));
});
