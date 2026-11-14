// Задача 2.491 (оценка транспорта): проверка в реестре уведомлений о залоге движимого имущества — эксперт отмечает дату и
// итог (залога нет / есть — номер уведомления и залогодержатель); строкой — в раздел «7. Описание объекта» черновика;
// ИИ-проверка — залог отмечен, а в отчёте о нём ни слова. Номера +7 999 000-49-41…44 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { runAutoChecks } from '../../src/ai/report-checks.mjs';
import { PLEDGE_HEAD, placePledge, pledgeLine } from '../../src/orders/pledge.mjs';

const FOUND = { checked_on: '2026-11-10', result: 'found', notice_no: '2026-001-123456-789', pledgee: 'ООО «Тестовый Банк»' };
const NONE = { checked_on: '2026-11-10', result: 'none', notice_no: '', pledgee: '' };

test('строка в черновик и место в разделе «Описание объекта»', () => {
  assert.equal(pledgeLine(null), null);
  assert.equal(pledgeLine(NONE), `${PLEDGE_HEAD} по данным реестра уведомлений о залоге движимого имущества (reestr-zalogov.ru) на 10.11.2026 сведений о залоге объекта оценки нет.`);
  assert.equal(pledgeLine({ ...FOUND, pledgee: 'ООО «Тестовый Банк».' }), `${PLEDGE_HEAD} по данным реестра уведомлений о залоге движимого имущества (reestr-zalogov.ru) на 10.11.2026 объект оценки находится в залоге — уведомление о возникновении залога № 2026-001-123456-789, залогодержатель — ООО «Тестовый Банк».`);
  const sections = [{ title: '6. Сведения об оценщике' }, { title: '7. Описание объекта оценки', pledge: true }];
  const body = '## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\nЛегковой автомобиль.';
  const placed = placePledge(body, sections, pledgeLine(NONE));
  assert.equal(placed, `## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\n${pledgeLine(NONE)}\nЛегковой автомобиль.`);
  assert.equal(placePledge(placed, sections, pledgeLine(FOUND)), `## 6. Сведения об оценщике\nТекст.\n## 7. Описание объекта оценки\n${pledgeLine(FOUND)}\nЛегковой автомобиль.`, 'прежняя строка заменена');
  assert.equal(placePledge(body, [{ title: '7. Описание объекта оценки' }], pledgeLine(NONE)), body, 'нет раздела с pledge — не трогаем');
  assert.equal(placePledge(body, sections, null), body);
});

const doc = (text) => [{ name: 'отчёт.txt', pages: [text] }];
const check = (text, pledge) => runAutoChecks(['pledge_match'], doc(text), { pledge }).pledge_match.map((f) => f.text);
const REPORT = ['ОТЧЁТ ОБ ОЦЕНКЕ № 12', '7. Описание объекта оценки', 'Легковой автомобиль, VIN XTA00000000000001.',
  'Ограничения (обременения) прав: не зарегистрированы.', 'Аналог № 2: продаётся, был в залоге у банка.'].join('\n');

test('ИИ-проверка: залог отмечен, а в отчёте о нём ни слова или сказано «нет»', () => {
  assert.deepEqual(check(REPORT, null), [], 'проверки в деле нет — молчим');
  assert.deepEqual(check(REPORT, NONE), [], 'залога нет, в отчёте нет — всё сходится; аналог не в счёт');
  assert.deepEqual(check(REPORT, FOUND), ['В деле отмечено: в реестре залогов на 10.11.2026 машина в залоге (уведомление № 2026-001-123456-789, залогодержатель — ООО «Тестовый Банк»), а в отчёте сказано, что обременений или залога нет — исправьте']);
  const silent = REPORT.replace('Ограничения (обременения) прав: не зарегистрированы.\n', '');
  const res = runAutoChecks(['pledge_match'], doc(silent), { pledge: FOUND }).pledge_match;
  assert.deepEqual(res.map((f) => f.text), ['В деле отмечено: в реестре залогов на 10.11.2026 машина в залоге (уведомление № 2026-001-123456-789, залогодержатель — ООО «Тестовый Банк»), а в отчёте о залоге ни слова — укажите залог в описании объекта и обременениях']);
  assert.equal(res[0].quote, 'ОТЧЁТ ОБ ОЦЕНКЕ № 12');
  // Строка из дела в отчёте — всё сказано.
  assert.deepEqual(check(`${silent}\n${pledgeLine(FOUND)}`, FOUND), []);
  // Сказано о залоге, а номера уведомления нет.
  assert.deepEqual(check(`${silent}\nОбъект находится в залоге у ООО «Тестовый Банк».`, FOUND),
    ['В деле отмечено в реестре залогов на 10.11.2026: уведомление № 2026-001-123456-789, залогодержатель — ООО «Тестовый Банк», а номера уведомления в отчёте нет — укажите его в описании объекта или обременениях']);
  // Залога нет, а в отчёте — залогодержатель (текст старого отчёта); «не находится в залоге» — не залог.
  assert.deepEqual(check(`${silent}\nЗалогодержатель — ООО «Другой Банк».`, NONE),
    ['По Вашей проверке в реестре залогов на 10.11.2026 залога нет, а в отчёте сказано о залоге — проверьте, нет ли текста из старого отчёта']);
  assert.deepEqual(check(`${silent}\nОбъект не находится в залоге.`, NONE), []);
  assert.deepEqual(check(`${silent}\n${pledgeLine(NONE)}`, NONE), []);
});

let S, owner, dispatcher, spec, other;
const FIELDS = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
  vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 120000 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004941');
  dispatcher = await login(S, '+79990004942');
  spec = await login(S, '+79990004943');
  other = await login(S, '+79990004944');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle'], ['expertise', 'car_damage']] });
  await makeSpecialist(S.sql, other.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

async function inWork(service = 'vehicle', fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Машина: залог' })).body.order;
  { const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields }); assert.equal(p.status, 200, JSON.stringify(p.body)); }
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  return o;
}

test('эксперт дела отмечает и меняет; стороны только читают; в черновике от ИИ; в ИИ-проверке', async () => {
  const o = await inWork();
  const base = `/api/orders/${o.id}/pledge`;
  const v0 = (await spec.req('GET', base)).body;
  assert.equal(v0.available, true);
  assert.equal(v0.can_write, true);
  assert.equal(v0.check, null);
  assert.equal(v0.vin, 'XTA00000000000001');
  const day = addDays(todayMsk(), -2);
  assert.equal((await spec.req('PUT', base, { checked_on: addDays(todayMsk(), 1), result: 'none' })).status, 400, 'завтра');
  assert.equal((await spec.req('PUT', base, { checked_on: addDays(todayMsk(), -400), result: 'none' })).status, 400, 'давно');
  assert.equal((await spec.req('PUT', base, { checked_on: '2026-02-30', result: 'none' })).status, 400);
  assert.equal((await spec.req('PUT', base, { checked_on: day, result: 'maybe' })).status, 400);
  assert.equal((await spec.req('PUT', base, { checked_on: day, result: 'found', notice_no: '', pledgee: 'Банк' })).status, 400, 'без номера');
  assert.equal((await spec.req('PUT', base, { checked_on: day, result: 'found', notice_no: '123', pledgee: '' })).status, 400, 'без залогодержателя');
  const v1 = (await spec.req('PUT', base, { checked_on: day, result: 'none', notice_no: 'лишнее', pledgee: 'лишнее' })).body;
  assert.deepEqual(v1.check, { checked_on: day, result: 'none', notice_no: null, pledgee: null });
  assert.match(v1.line, /сведений о залоге объекта оценки нет\.$/);
  const v2 = (await spec.req('PUT', base, { checked_on: day, result: 'found', notice_no: ' 2026-001-123456-789 ', pledgee: 'ООО «Тестовый Банк»' })).body;
  assert.deepEqual(v2.check, { checked_on: day, result: 'found', notice_no: '2026-001-123456-789', pledgee: 'ООО «Тестовый Банк»' });

  for (const c of [owner, dispatcher]) {
    const v = (await c.req('GET', base)).body;
    assert.equal(v.can_write, false);
    assert.equal(v.line, v2.line);
    assert.equal((await c.req('PUT', base, { checked_on: day, result: 'none' })).status, 403);
    assert.equal((await c.req('DELETE', base)).status, 403);
  }
  assert.equal((await other.req('GET', base)).status, 404);

  // Черновик от ИИ: строка — сразу под заголовком «7. Описание объекта оценки»; модели сказано не противоречить.
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const lines = d.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, d.body.slice(0, 400));
  assert.equal(lines[h + 1], v2.line);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((x) => x.content).join('\n');
  assert.ok(prompt.includes(v2.line));

  // ИИ-проверка дела: залог отмечен, а в отчёте ни слова — находка в «Права и обременения».
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('ОТЧЁТ ОБ ОЦЕНКЕ\nVIN XTA00000000000001.\nПробег: 120 000 км.\n'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status, 201);
  const found = async () => {
    S.providers.ai.reset();
    const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
    assert.equal(ai.status, 201, JSON.stringify(ai.body));
    return (ai.body.ai.items.find((i) => i.id === 'rights').found ?? []).map((f) => f.text).filter((t) => /реестре залогов/.test(t));
  };
  assert.equal((await found()).length, 1);
  assert.equal((await spec.req('PUT', base, { checked_on: day, result: 'none' })).status, 200);
  assert.deepEqual(await found(), []);

  // Убрать; после сдачи — только чтение.
  assert.equal((await spec.req('DELETE', base)).body.check, null);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await spec.req('GET', base)).body.can_write, false);
  assert.equal((await spec.req('PUT', base, { checked_on: day, result: 'none' })).status, 409);
});

test('не оценка транспорта — блока нет', async () => {
  const o = await inWork('car_damage', { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021,
    vin: 'XTA00000000000001', reg_number: 'А001АА777', accident_date: '14.09.2026', accident_place: 'г. Москва', damage: 'Бампер', method: 'osago' });
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}/pledge`)).body, { available: false });
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/pledge`, {})).status, 409);
});
