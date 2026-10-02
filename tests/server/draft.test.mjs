// Черновик заключения от ИИ (задача 2.2): исполнитель получает черновик по данным заявки, документам и списку фото, правит
// его в кабинете и сам прикладывает итоговый файл результата. Заказчик черновика не видит; ИИ ничего не выдаёт сам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { cleanDraftAnswer } from '../../src/ai/ai.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { textToDocx } from '../../src/docs/docx.mjs';
import { makeDocx } from '../tools/make-docs.mjs';

let S, owner, other, dispatcher, admin, spec;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 9', area: '54.3' };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000901');
  other = await login(S, '+79990000902');
  dispatcher = await login(S, '+79990000903');
  admin = await login(S, '+79990000904');
  spec = await login(S, '+79990000905');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await makeSpecialist(S.sql, spec.user.id);
  await owner.req('PATCH', '/api/me', { full_name: 'Тестова Заказчица' });
});
after(async () => { await S?.close(); });

const lastPrompt = () => S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

const put = (c, o, body, name, type, path = 'documents') => c.req('POST', `/api/orders/${o.id}/${path}`, Buffer.from(body), {
  raw: true, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
});

async function inWork(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await put(owner, o, JPEG, 'фасад.jpg', 'image/jpeg')).status, 201);
  assert.equal((await put(owner, o, JPEG, 'кухня.png', 'image/png')).status, 201);
  const docx = makeDocx(['Сведения о квартире', 'Квартира на 5 этаже, ремонт 2020 года.']);
  assert.equal((await put(owner, o, docx, 'Сведения.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).status, 201);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

test('разделы черновика — в описании модуля; у услуги свои (аналоги — не у товароведческой)', () => {
  const reg = createRegistry();
  const realty = reg.draftSections('expertise', 'realty').map((s) => s.id);
  assert.ok(realty.includes('analogs') && !realty.includes('questions'));
  const goods = reg.draftSections('expertise', 'goods').map((s) => s.id);
  assert.ok(goods.includes('questions') && !goods.includes('analogs'));
  assert.deepEqual(reg.draftSections('expertise', 'nope'), []);
  const { draft, ...noDraft } = structuredClone(expertise);
  assert.ok(draft.length);
  assert.deepEqual(createRegistry([noDraft]).draftSections('expertise', 'realty'), [], 'без разделов — черновик не готовится');
});

test('черновик от ИИ: по данным заявки, документам и списку фото; без имён и телефонов; пометки «заполнить» вместо выдумки', async () => {
  const o = await inWork('Квартира для черновика');
  let r = await spec.req('GET', `/api/orders/${o.id}/draft`);
  assert.equal(r.status, 200);
  assert.equal(r.body.draft, null);
  assert.equal(r.body.can_ai, true);
  assert.ok(r.body.sections.some((s) => s.id === 'analogs'));

  S.providers.ai.reset();
  r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.draft;
  assert.equal(d.source, 'ai');
  assert.equal(d.model, 'fake');
  assert.equal(d.versions, 1);
  assert.deepEqual(d.inputs.photos, ['фасад.jpg', 'кухня.png']);
  assert.deepEqual(d.inputs.docs, [{ name: 'Сведения.docx', read: true, truncated: false }]);
  assert.match(d.body, /^## Вводная часть/);
  assert.match(d.body, /Адрес объекта: г\. Москва, тестовая ул\., 9/, 'данные заявки');
  assert.match(d.body, /Фото 1 \(фасад\.jpg\): \[описать по фото: фасад\.jpg\]/);
  assert.match(d.body, /\[заполнить: расчёт и итоговая величина\]/);
  for (const s of (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.sections) {
    assert.ok(d.body.includes(`## ${s.title}`), `раздел ${s.id}`);
  }
  const prompt = lastPrompt();
  assert.match(prompt, /- фасад\.jpg \(загружено /);
  assert.match(prompt, /Квартира на 5 этаже, ремонт 2020 года\./, 'текст документа заказчика ушёл в модель');
  assert.match(prompt, /Не придумывай цифры/);
  assert.doesNotMatch(prompt, /Тестова Заказчица|79990000901/, 'без имён и телефонов');
  assert.equal(S.providers.ai.calls.at(-1).args.purpose, 'draft');
  const [usage] = await S.sql`select purpose from ai_usage where user_id = ${spec.user.id} order by id desc limit 1`;
  assert.equal(usage.purpose, 'draft');

  // Заказчик черновика не видит — ни черновика, ни файла; посторонний — «не найдено».
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/draft`)).status, 403);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).status, 403);
  assert.equal((await other.req('GET', `/api/orders/${o.id}/draft`)).status, 404);
  // Диспетчер и администратор видят, но не правят.
  const disp = (await dispatcher.req('GET', `/api/orders/${o.id}/draft`)).body;
  assert.equal(disp.draft.body, d.body);
  assert.equal(disp.can_edit, false);
  assert.equal(disp.draft.mine, false);
  for (const c of [dispatcher, admin]) {
    assert.equal((await c.req('PUT', `/api/orders/${o.id}/draft`, { body: 'x', from: d.id })).status, 403);
    assert.equal((await c.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).status, 403);
    assert.equal((await c.req('POST', `/api/orders/${o.id}/draft/result`, { from: d.id, confirm: true })).status, 403);
  }
});

test('эксперт правит черновик и прикладывает итоговый файл: «уже изменился», пометки, подтверждение; результат — Word', async () => {
  const o = await inWork('Квартира: правка черновика');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: null, confirm: true })).status, 400, 'черновика ещё нет');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: 'x', from: '1' })).status, 409, 'не та версия');
  const d1 = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  // Второй раз — только от версии, которую человек видел: иначе правка потерялась бы.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: null })).status, 409);
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: '   ', from: d1.id })).status, 400);

  let r = await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: d1.id, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'draft_gaps');
  assert.match(r.body.message, /\[заполнить|\[описать/);

  const final = d1.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'Эксперт: заполнено вручную') + '\nИтоговая стоимость: 15 000 000 руб. Заключение № 9/2026.';
  r = await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: final, from: d1.id });
  assert.equal(r.status, 200);
  const d2 = r.body.draft;
  assert.equal(d2.source, 'edit');
  assert.equal(d2.versions, 2);
  assert.deepEqual(d2.inputs, d1.inputs);
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: final, from: d2.id })).body.draft.versions, 2, 'без изменений — новой версии нет');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: `${final}!`, from: d1.id })).status, 409, 'устаревшая вкладка');

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: d2.id })).status, 400, 'без подтверждения');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: d1.id, confirm: true })).status, 409, 'не та версия');
  r = await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: d2.id, confirm: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.document.kind, 'result');
  assert.equal(r.body.document.filename, 'Заключение.docx');
  const [doc] = await S.sql`select * from documents where id = ${r.body.document.id}`;
  assert.equal(doc.uploaded_by, spec.user.id);
  const read = await extractPages(await S.providers.storage.get(doc.storage_key), doc.filename, doc.mime);
  assert.match(read.pages.join('\n'), /Итоговая стоимость: 15 000 000 руб\./, 'в файле — текст эксперта');
  assert.doesNotMatch(read.pages.join('\n'), /\[заполнить/);

  // Заказчик результат до проверки не видит; ИИ-проверка читает приложенный Word.
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/documents`)).body.results_hidden, true);
  const ai = (await spec.req('POST', `/api/orders/${o.id}/review/ai`)).body.ai;
  assert.deepEqual(ai.files.map((f) => [f.name, f.read]), [['Заключение.docx', true]]);
  assert.equal(ai.items.find((i) => i.id === 'requisites').hint, 'ok');

  // Сдал на проверку — черновик больше не правится, но виден исполнителю и диспетчеру.
  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: 'поздно', from: d2.id })).status, 403);
  const view = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body;
  assert.equal(view.can_edit, false);
  assert.equal(view.draft.body, final);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/draft`)).status, 403);
  const acts = (await S.sql`select action from audit_log where subject_id = ${o.id} and action like 'draft.%' order by id`).map((a) => a.action);
  assert.deepEqual(acts, ['draft.ai', 'draft.save', 'draft.attach']);
});

test('модель пропустила разделы или обернула ответ — разделы добавлены с пометкой; модель недоступна — черновик не меняется', async () => {
  const o = await inWork('Квартира: модель капризничает');
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '```\n## Вводная часть\nОснование: договор\n```', model: 'fake' });
  try {
    const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
    assert.doesNotMatch(d.body, /```/);
    assert.match(d.body, /^## Вводная часть\nОснование: договор/);
    assert.match(d.body, /## Выводы\n\[заполнить: раздел не подготовлен\]/);
    S.providers.ai.complete = async () => { throw new Error('нет связи'); };
    const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id });
    assert.equal(r.status, 503);
    assert.equal((await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft.id, d.id);
  } finally { S.providers.ai.complete = orig; }
  const sections = [{ id: 'a', title: 'Объект: что оценивается' }, { id: 'b', title: 'Выводы' }];
  assert.equal(cleanDraftAnswer(sections, '# Объект\nквартира\n### выводы\nнет'), '# Объект\nквартира\n### выводы\nнет', 'заголовки разного уровня и регистра узнаются');
});

test('Word из черновика: заголовки и абзацы, спецсимволы, лишние управляющие символы — файл читается', async () => {
  const buf = textToDocx('## Раздел <1> & «2»\nСтрока\u0001 с символом\n\nИтог');
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const got = await extractPages(buf, 'Заключение.docx');
  assert.deepEqual(got.pages, ['Раздел <1> & «2»\nСтрока с символом\n\nИтог']);
});
