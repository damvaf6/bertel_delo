// Прогон 2.538 (пачка «Жилой дом с участком», 2.529–2.537): дело дома целиком — заявка, черновик от ИИ с таблицей
// «Стоимость дома и участка», эксперт вписывает суммы, Word, ИИ-проверка по тексту Word с выпиской ЕГРН на участок, суммы для
// сводки руководителя из того же черновика.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { HOUSE_HEAD, houseFacts, houseTable, landEgrnFacts } from '../../src/orders/house.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { runAutoChecks } from '../../src/ai/report-checks.mjs';

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Садовая, д. 7', area: 120,
  house_land: 'own', land_cadastral: '50:20:0010101:15', land_area: 12, house_walls: 'brick', house_gas: 'main', house_winter: 'yes' };
const LAND_EGRN = { id: 'e1', name: 'Выписка на участок.pdf', land: true, pages: [[
  'Выписка из Единого государственного реестра недвижимости об объекте недвижимости',
  'Вид объекта недвижимости: Земельный участок',
  'Кадастровый номер: 50:20:0010101:15',
  'Площадь: 1200 +/- 12 кв. м',
].join('\n')] };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005940');
  dispatcher = await login(S, '+79990005941');
  spec = await login(S, '+79990005942');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function houseCase(fields, ready = async () => {}) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дом: прогон' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  await ready(o);
  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { o, d: r.body.draft };
}
async function wordText(id) {
  const w = await fetch(`${S.base}/api/orders/${id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  return (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages;
}

test('участок в собственности: суммы вписаны — Word проходит проверку «Дом с участком», сводка видит долю участка', async () => {
  const { o, d } = await houseCase(BASE);
  const lines = d.body.split('\n');
  const t = lines.indexOf(HOUSE_HEAD);
  assert.ok(t > 0);
  const sums = ['8 000 000', '2 000 000', '10 000 000', '20'];
  for (let k = 0; k < 4; k += 1) lines[t + 1 + k] = lines[t + 1 + k].replace('[заполнить]', sums[k]);
  const body = lines.join('\n').replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'текст');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body, from: d.id })).status, 200);
  assert.deepEqual(houseFacts(body), { house: 8000000, land: 2000000, total: 10000000, share: 20 });
  const pages = await wordText(o.id);
  const res = runAutoChecks(['house_land'], [{ name: 'Отчёт.docx', kind: 'docx', pages }], { service: 'realty', fields: BASE, egrn: [LAND_EGRN] }).house_land;
  assert.deepEqual(res, []);
});

test('полная ИИ-проверка отчёта о доме из Word: выписки на дом и на участок — без ложных находок', async () => {
  const { o, d } = await houseCase(BASE);
  const lines = d.body.split('\n');
  const t = lines.indexOf(HOUSE_HEAD);
  const sums = ['8 000 000', '2 000 000', '10 000 000', '20'];
  for (let k = 0; k < 4; k += 1) lines[t + 1 + k] = lines[t + 1 + k].replace('[заполнить]', sums[k]);
  const body = lines.join('\n').replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'текст');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body, from: d.id })).status, 200);
  const day = todayMsk().split('-').reverse().join('.');
  const put = async (text, name) => (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(text), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } })).body.document;
  await put(['Выписка из Единого государственного реестра недвижимости об объекте недвижимости', `${day} № КУВИ-001/2026-77001`,
    'Вид объекта недвижимости: Здание', 'Назначение: жилой дом', 'Кадастровый номер: 50:20:0010101:301', 'Площадь: 120 кв. м'].join('\n'), 'Выписка на дом.txt');
  await put(['Выписка из Единого государственного реестра недвижимости об объекте недвижимости', `${day} № КУВИ-001/2026-77002`,
    'Вид объекта недвижимости: Земельный участок', 'Кадастровый номер: 50:20:0010101:15', 'Площадь: 1200 +/- 12 кв. м'].join('\n'), 'Выписка на участок.txt');
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  const up = await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(await w.arrayBuffer()), {
    raw: true, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x-file-name': encodeURIComponent('Отчёт.docx') } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  S.providers.ai.reset();
  const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(ai.status, 201, JSON.stringify(ai.body));
  const found = ai.body.ai.items.flatMap((i) => (i.found ?? []).map((f) => `${i.id}: ${f.text}`));
  // Раньше номер участка из таблицы «Стоимость дома и участка» (2.531) сверялся с выпиской на дом — «не совпадает».
  assert.deepEqual(found.filter((f) => /кадастров|участ|площад|дом/iu.test(f)), [], found.join('\n'));
});

test('номер участка у дома — не номер дома; чужой номер у дома — по-прежнему находка', () => {
  const egrn = [{ id: 'h', name: 'Выписка на дом.pdf', pages: [['Выписка из Единого государственного реестра недвижимости об объекте недвижимости',
    'Вид объекта недвижимости: Здание', 'Назначение: жилой дом', 'Кадастровый номер: 50:20:0010101:301'].join('\n')] }, LAND_EGRN];
  const run = (text, fields = BASE) => runAutoChecks(['cadastral_match'], [{ name: 'Отчёт.docx', kind: 'docx', pages: [text] }],
    { service: 'realty', fields, egrn }).cadastral_match.map((f) => f.text).filter((t) => /Кадастровый/u.test(t));
  const land = 'Жилой дом с кадастровым номером 50:20:0010101:301 расположен на земельном участке с кадастровым номером 50:20:0010101:15.';
  assert.deepEqual(run(land), []);
  assert.deepEqual(run('Земельный участок под домом (кадастровый номер 50:20:0010101:15, 12 сот. — по заявке), руб. | 2 000 000'), []);
  assert.equal(run('Жилой дом с кадастровым номером 50:20:0010101:999, общая площадь 120 кв. м').length, 1);
  // Не дом (квартира) — номер рядом с «участком» сверяется, как раньше.
  assert.equal(run(land, { ...BASE, object_type: 'flat' }).length, 1);
});

test('выписки на дом и на участок до черновика: в таблицу задания и перечень документов — по дому, участок своим', async () => {
  const day = todayMsk().split('-').reverse().join('.');
  const fields = { ...BASE, land_area: 15 };
  const { o, d } = await houseCase(fields, async (o) => {
    const put = async (text, name) => (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(text), {
      raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } })).body.document;
    await put(['Выписка из Единого государственного реестра недвижимости об объекте недвижимости', `${day} № КУВИ-001/2026-77001`,
      'Вид объекта недвижимости: Здание', 'Назначение: жилой дом', 'Кадастровый номер: 50:20:0010101:301', 'Площадь: 120 кв. м',
      'Правообладатель: Тестов Тест Тестович', 'Вид права: Собственность'].join('\n'), 'Выписка на дом.txt');
    await put(['Выписка из Единого государственного реестра недвижимости об объекте недвижимости', `${day} № КУВИ-001/2026-77002`,
      'Вид объекта недвижимости: Земельный участок', 'Кадастровый номер: 50:20:0010101:15', 'Площадь: 1200 +/- 12 кв. м',
      'Правообладатель: Тестов Тест Тестович', 'Вид права: Собственность'].join('\n'), 'Выписка на участок.txt');
  });
  const lines = d.body.split('\n');
  // Дом — по выписке на дом, а не на участок.
  assert.ok(lines.includes('| Кадастровый номер | 50:20:0010101:301 (по выписке ЕГРН) |'), d.body);
  assert.ok(lines.includes('| Площадь, кв. м | 120 (по выписке ЕГРН) |'));
  assert.ok(lines.some((l) => l.startsWith('2. Выписка из ЕГРН № КУВИ-001/2026-77002 от')), 'выписка на участок — в перечне документов');
  // 2.538: номер и площадь участка в таблице «Стоимость дома и участка» — из выписки на участок, а не из заявки (15 сот.).
  const row = '| Земельный участок под домом (кадастровый номер 50:20:0010101:15, 1 200 кв. м — по выписке ЕГРН на участок), руб. | [заполнить] |';
  assert.ok(lines.includes(row), lines.filter((l) => /участок под домом/u.test(l)).join('\n'));
  const g = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.ok(g.body.house.includes(row), JSON.stringify(g.body.house));
  // Суммы вписаны — проверка «Дом с участком» по таблице молчит.
  const t = lines.indexOf(HOUSE_HEAD);
  const sums = ['8 000 000', '2 000 000', '10 000 000', '20'];
  for (let k = 0; k < 4; k += 1) lines[t + 1 + k] = lines[t + 1 + k].replace('[заполнить]', sums[k]);
  const table = lines.slice(t, t + 5);
  const res = runAutoChecks(['house_land'], [{ name: 'Отчёт.docx', kind: 'docx', pages: [table.join('\n')] }], { service: 'realty', fields, egrn: [LAND_EGRN] }).house_land;
  assert.deepEqual(res.filter((f) => !/не указан кадастровый/u.test(f.text)), []);
});

test('таблица дома: из выписки на участок — номер и площадь; нет выписки — по заявке', () => {
  const f = { object_type: 'house', house_land: 'own', land_cadastral: '50:20:0010101:15', land_area: 12.5 };
  assert.equal(houseTable('realty', f)[2], '| Земельный участок под домом (кадастровый номер 50:20:0010101:15, 12,5 сот. — по заявке, сверьте с выпиской ЕГРН на участок), руб. | [заполнить] |');
  const land = landEgrnFacts([LAND_EGRN]);
  assert.deepEqual(land, { cadastral: '50:20:0010101:15', area: 1200 });
  assert.equal(houseTable('realty', f, land)[2], '| Земельный участок под домом (кадастровый номер 50:20:0010101:15, 1 200 кв. м — по выписке ЕГРН на участок), руб. | [заполнить] |');
  assert.equal(houseTable('realty', { ...f, house_land: 'lease' }, { cadastral: null, area: 600 })[2],
    '| Право аренды участка под домом (кадастровый номер 50:20:0010101:15 (по заявке), 600 кв. м — по выписке ЕГРН на участок), руб. | [заполнить] (если переходит вместе с домом; иначе — «не оценивается») |');
  assert.equal(landEgrnFacts([{ id: 'h', name: 'дом', pages: ['Вид объекта недвижимости: Здание\nКадастровый номер: 50:20:0010101:301'] }]), null);
});

