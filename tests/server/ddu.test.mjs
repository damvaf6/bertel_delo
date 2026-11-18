// Задача 2.539 (квартира в новостройке, права по ДДУ): в «Что оцениваем» — «Квартира в новостройке (права по ДДУ)»; в заявке
// номер и дата ДДУ, застройщик, ЖК и корпус, условный номер, проектная площадь, срок передачи и цена по договору
// (необязательные); подсказка в деле — оценивается право требования, не указаны номер или дата, кадастровый номер в заявке,
// срок передачи прошёл; строкой «Из заявки: …» — в «7. Описание объекта оценки». Номера +7 999 000-59-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { dduNotices, dduDay, dduTaskLine, dduAssumption, placeDduTask, placeDduAssumption, DDU_TASK_HEAD, DDU_ASSUME_HEAD } from '../../src/orders/ddu.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

const LINE = `${FACTS_HEAD} номер ДДУ — ЖК-12/3-145; дата ДДУ — 14.03.2025; застройщик — ООО «СЗ Тестовый»; ЖК, корпус, секция — ЖК «Тестовый», корп. 3, секция 2; условный номер квартиры — 145; проектная площадь — 41,3 кв. м; срок передачи квартиры по договору — IV квартал 2027; цена по договору — 9 850 000 руб.`;
const DDU = { ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_complex: 'ЖК «Тестовый», корп. 3, секция 2', ddu_unit: '145', ddu_area: 41.3, ddu_handover: 'IV квартал 2027', ddu_price: 9850000 };

test('подсказки и строка «Из заявки»', () => {
  const ids = (f, today = '2026-11-18') => dduNotices('realty', f, today).map((n) => n.id);
  assert.deepEqual(ids({ object_type: 'flat' }), [], 'квартира без сведений о ДДУ — молчим');
  assert.deepEqual(ids({ object_type: 'flat', ddu_number: '1' }), ['ddu_type']);
  assert.deepEqual(ids({ object_type: 'ddu' }), ['ddu_right', 'ddu_doc']);
  assert.deepEqual(ids({ object_type: 'ddu', ddu_number: '1' }), ['ddu_right', 'ddu_doc'], 'без даты — уточнить');
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU }), ['ddu_right']);
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, cadastral: '50:20:0010101:55' }), ['ddu_right', 'ddu_cadastral']);
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, ddu_handover: '30.09.2026' }), ['ddu_right', 'ddu_late']);
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, ddu_handover: '31.12.2027' }), ['ddu_right'], 'срок впереди — молчим');
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, ddu_handover: '18.11.2026' }), ['ddu_right'], 'срок сегодня — ещё не прошёл');
  assert.equal(dduDay('31.12.2027'), '2027-12-31');
  assert.equal(dduDay('IV квартал 2027'), null);
  assert.match(dduNotices('realty', { object_type: 'ddu' })[0].text, /право требования по ДДУ \(214-ФЗ\), а не квартира/);
  assert.match(dduNotices('realty', { object_type: 'ddu', ...DDU, ddu_handover: '30.09.2026' }, '2026-11-18')[1].text, /\(30\.09\.2026\) уже прошёл/);
  assert.deepEqual(dduNotices('vehicle', { object_type: 'ddu' }), []);

  const registry = createRegistry();
  const fields = registry.service('expertise', 'realty').fields;
  assert.ok(fields.find((f) => f.id === 'object_type').options.some((o) => o.id === 'ddu' && o.name === 'Квартира в новостройке (права по ДДУ)'));
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.facts);
  assert.equal(sec.id, 'r_object');
  assert.equal(factsLine(fields, sec.facts, DDU), LINE);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Тестовый», корп. 3 (строительный адрес)' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005911');
  dispatcher = await login(S, '+79990005912');
  spec = await login(S, '+79990005913');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('поля необязательны и проверяются; подсказка в деле; строка — в черновике от ИИ', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Новостройка для ипотеки' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['ddu_right', 'ddu_doc']);
  for (const wrong of [{ ddu_date: '2025-03-14' }, { ddu_date: '14.3.25' }, { ddu_area: 0 }, { ddu_area: 'сорок' }, { ddu_price: 0 }, { ddu_number: 'x'.repeat(61) }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  assert.equal((await patch({ ...BASE, ...DDU })).status, 200);
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['ddu_right']);

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['ddu_right'], 'эксперт видит ту же подсказку');

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE);
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
  // 2.541: объект — право требования в «Задание на оценку», допущение — в раздел допущений; по одной строке.
  const t = lines.findIndex((l) => /^#{1,3}\s*2\. Задание на оценку/.test(l));
  assert.equal(lines[t + 1], dduTaskLine('realty', { object_type: 'ddu', ...DDU }));
  const a = lines.findIndex((l) => /^#{1,3}\s*5\. Допущения/.test(l));
  assert.equal(lines[a + 1], dduAssumption('realty', { object_type: 'ddu' }));
  assert.equal(lines.filter((l) => l.startsWith(DDU_TASK_HEAD)).length, 1);
  assert.equal(lines.filter((l) => l.startsWith(DDU_ASSUME_HEAD)).length, 1);
  const [{ inputs }] = await S.sql`select inputs from result_drafts where order_id = ${o.id} order by id desc limit 1`;
  assert.equal(inputs.ddu, true);
});

test('2.541: строка «право требования по ДДУ» и допущение — только у ДДУ, заменяются, без пропусков — [заполнить]', () => {
  const full = dduTaskLine('realty', { object_type: 'ddu', ...DDU });
  assert.equal(full, `${DDU_TASK_HEAD} договор участия в долевом строительстве № ЖК-12/3-145 от 14.03.2025 (214-ФЗ); застройщик — ООО «СЗ Тестовый»; объект строительства — ЖК «Тестовый», корп. 3, секция 2; квартира с условным номером 145; проектная площадь — 41,3 кв. м; срок передачи по договору — IV квартал 2027. Оцениваемые права — право требования передачи квартиры после ввода дома в эксплуатацию, не право собственности на квартиру. Вид стоимости — рыночная стоимость права требования.`);
  const bare = dduTaskLine('realty', { object_type: 'ddu' });
  assert.match(bare, /№ \[заполнить\] от \[заполнить\]/);
  assert.match(bare, /застройщик — \[заполнить\]; квартира с условным номером \[заполнить\]; проектная площадь — \[заполнить\]\./);
  assert.match(dduTaskLine('realty', { object_type: 'ddu' }, 'ликвидационная стоимость'), /Вид стоимости — ликвидационная стоимость \(по заданию на оценку\)\.$/);
  for (const [s, f] of [['realty', { object_type: 'flat', ...DDU }], ['land', { object_type: 'ddu' }], ['realty', {}]]) {
    assert.equal(dduTaskLine(s, f), null);
    assert.equal(dduAssumption(s, f), null);
  }
  assert.match(dduAssumption('realty', { object_type: 'ddu' }), /Площадь — проектная, по договору/);

  const sections = [{ title: '2. Задание на оценку', table: 'task' }, { title: '5. Допущения и ограничительные условия' }];
  const body = '## 2. Задание на оценку\nтекст\n## 5. Допущения и ограничительные условия\nабзац';
  const once = placeDduAssumption(placeDduTask(body, sections, full), sections, dduAssumption('realty', { object_type: 'ddu' }));
  assert.equal(once.split('\n')[1], full);
  assert.equal(once.split('\n')[4], dduAssumption('realty', { object_type: 'ddu' }));
  const twice = placeDduTask(once, sections, bare);
  assert.equal(twice.split('\n').filter((l) => l.startsWith(DDU_TASK_HEAD)).length, 1, 'прежняя строка заменяется');
  assert.equal(twice.split('\n')[1], bare);
  assert.equal(placeDduTask(body, sections, null), body);
  assert.equal(placeDduTask('без заголовков', sections, full), 'без заголовков');
});

// 2.540: запрос документов по ДДУ — договор с отметкой о регистрации, справка об оплате, план из договора, разрешение на ввод;
// без выписки на квартиру, документа о собственности и техпаспорта. У участка выписка остаётся.
test('2.540: перечень документов по ДДУ', () => {
  const registry = createRegistry();
  const ids = (f, sid = 'realty') => registry.requestDocs('expertise', sid, null, f).map((c) => c.id);
  const ddu = ids({ object_type: 'ddu' });
  for (const id of ['ddu_contract', 'ddu_payment', 'ddu_plan', 'ddu_permit']) assert.ok(ddu.includes(id), id);
  for (const id of ['egrn', 'title_deed', 'tech_plan']) assert.ok(!ddu.includes(id), `${id} — не у ДДУ`);
  assert.ok(ddu.includes('encumbrance'), 'ипотека на права по ДДУ — пункт остаётся');
  const flat = ids({ object_type: 'flat' });
  for (const id of ['egrn', 'title_deed', 'tech_plan']) assert.ok(flat.includes(id), id);
  for (const id of ['ddu_contract', 'ddu_payment', 'ddu_plan', 'ddu_permit']) assert.ok(!flat.includes(id), `${id} — не у квартиры`);
  assert.ok(ids({}, 'land').includes('egrn') && ids({}, 'land').includes('title_deed'), 'у участка поля «Что оцениваем» нет — выписка остаётся');
  assert.ok(ids({ object_type: 'ddu', purpose: 'bank' }).includes('bank_task'), 'для банка — и задание на оценку');
  assert.match(registry.requestDocs('expertise', 'realty', null, { object_type: 'ddu' })[0].title, /с отметкой о регистрации/);

  // Описание модуля: skip у документа — поле-список хотя бы у одной услуги и его значения.
  const patch = (c) => ({ ...expertise, request_docs: expertise.request_docs.map((d) => (d.id === 'egrn' ? { ...d, skip: c } : d)) });
  assert.throws(() => validateModule(patch({ field: 'nope', in: ['x'] })), /skip\.field/);
  assert.throws(() => validateModule(patch({ field: 'object_type', in: ['castle'] })), /skip\.in/);
  assert.throws(() => validateModule(patch({ field: 'address', in: ['ddu'] })), /skip\.field/);
  assert.throws(() => validateModule(patch({ field: 'object_type', in: ['ddu'], extra: 1 })), /extra/);
  assert.doesNotThrow(() => validateModule(expertise));
});

test('2.540: в деле по ДДУ эксперт запрашивает документы по договору, а старая выписка не просит «свежую»', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'ДДУ: документы' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...BASE, ...DDU } })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  const list = async (c = spec) => (await c.req('GET', `/api/orders/${o.id}/doc-requests`)).body;
  const r0 = await list();
  const cat = r0.catalog.map((c) => c.id);
  assert.ok(cat.includes('ddu_contract') && cat.includes('ddu_payment') && !cat.includes('egrn') && !cat.includes('tech_plan'), cat.join(','));
  const res = await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['ddu_contract', 'ddu_payment', 'ddu_plan'] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.requests.map((x) => x.item_id).sort(), ['ddu_contract', 'ddu_payment', 'ddu_plan']);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn'] })).status, 400, 'выписки на квартиру в перечне нет');
  const mine = await list(owner);
  assert.ok(mine.requests.some((x) => x.item_id === 'ddu_contract' && /штампом Росреестра/.test(x.hint ?? '')), JSON.stringify(mine.requests[0]));

  // Выписка о регистрации договора двухмесячной давности — «запросите свежую» не появляется: выписки на квартиру нет.
  const ru = (iso) => iso.split('-').reverse().join('.');
  const body = `Выписка из Единого государственного реестра недвижимости\n${ru(addDays(todayMsk(), -60))} № КУВИ-001/2026-5540001\nДоговор участия в долевом строительстве`;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Выписка о регистрации ДДУ.txt') } })).status, 201);
  assert.equal((await list()).egrn_old, null);
});
