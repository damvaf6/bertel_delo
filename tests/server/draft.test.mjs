// Черновик заключения от ИИ (задача 2.2): исполнитель получает черновик по данным заявки, документам и списку фото, правит
// его в кабинете и сам прикладывает итоговый файл результата. Заказчик черновика не видит; ИИ ничего не выдаёт сам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { cleanDraftAnswer } from '../../src/ai/ai.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { buildReport, parseDraft, DOCX_MIME } from '../../src/docs/docx.mjs';
import { makeDocx } from '../tools/make-docs.mjs';
import { ANALOGS_MARK, COURT_WARNING, splitQuestions } from '../../src/docs/report.mjs';
import { validateModule } from '../../src/modules/index.mjs';

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
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty'], ['expertise', 'vehicle'], ['expertise', 'land'], ['expertise', 'movable'], ['expertise', 'goods'], ['expertise', 'construction'], ['expertise', 'handwriting']] });
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
  assert.ok(realty.includes('r_compare') && !realty.includes('g_questions'));
  const goods = reg.draftSections('expertise', 'goods').map((s) => s.id);
  assert.ok(goods.includes('g_questions') && !goods.includes('r_compare'));
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
  assert.ok(r.body.sections.some((s) => s.id === 'r_compare'));

  S.providers.ai.reset();
  r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.draft;
  assert.equal(d.source, 'ai');
  assert.equal(d.model, 'fake');
  assert.equal(d.versions, 1);
  assert.deepEqual(d.inputs.photos, ['фасад.jpg', 'кухня.png']);
  assert.deepEqual(d.inputs.docs, [{ name: 'Сведения.docx', read: true, truncated: false }]);
  assert.match(d.body, /^## 1\. Основные факты и выводы/);
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

  // Метка таблицы аналогов (2.32): эксперт без аналогов в деле написал таблицу сам — метку убирает.
  assert.ok(d1.body.includes(ANALOGS_MARK), 'в разделе аналогов — метка таблицы');
  const final = d1.body.replace(ANALOGS_MARK, '| № | Аналог |\n| 1 | эксперт вписал сам |').replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'Эксперт: заполнено вручную') + '\nИтоговая стоимость: 15 000 000 руб. Заключение № 9/2026.';
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
  assert.equal(r.body.document.filename, 'Отчёт об оценке.docx', 'имя — по документу услуги (2.29)');
  const [doc] = await S.sql`select * from documents where id = ${r.body.document.id}`;
  assert.equal(doc.uploaded_by, spec.user.id);
  const read = await extractPages(await S.providers.storage.get(doc.storage_key), doc.filename, doc.mime);
  assert.match(read.pages.join('\n'), /Итоговая стоимость: 15 000 000 руб\./, 'в файле — текст эксперта');
  assert.doesNotMatch(read.pages.join('\n'), /\[заполнить/);

  // Заказчик результат до проверки не видит; ИИ-проверка читает приложенный Word.
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/documents`)).body.results_hidden, true);
  const ai = (await spec.req('POST', `/api/orders/${o.id}/review/ai`)).body.ai;
  assert.deepEqual(ai.files.map((f) => [f.name, f.read]), [['Отчёт об оценке.docx', true]]);
  assert.equal(ai.items.find((i) => i.id === 'requisites').hint, 'ok');

  // Сдал на проверку — черновик больше не правится, но виден исполнителю и диспетчеру.
  await signResults(S, spec, o.id);
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
  S.providers.ai.complete = async () => ({ text: '```\n## 2. Задание на оценку\nОснование: договор\n```', model: 'fake' });
  try {
    const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
    assert.doesNotMatch(d.body, /```/);
    // Под «Заданием на оценку» программа сама ставит таблицу «задание» из полей заявки (2.29), дальше — текст модели.
    assert.match(d.body, /## 2\. Задание на оценку\n\| Сведение \| Значение \|\n\| Услуга \| Оценка недвижимости \|\n/);
    assert.match(d.body, /\| Адрес объекта \| г\. Москва, тестовая ул\., 9 \|\n[^#]*Основание: договор/);
    assert.match(d.body, /## 14\. Согласование результатов и итоговая величина\n\| Подход \| Стоимость, руб\. \| Вес \|\n\| Сравнительный \| \[заполнить\] \| \[заполнить\] \|/);
    assert.match(d.body, /## 9\. Наиболее эффективное использование\n\[заполнить: раздел не подготовлен\]/);
    S.providers.ai.complete = async () => { throw new Error('нет связи'); };
    const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id });
    assert.equal(r.status, 503);
    assert.equal((await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft.id, d.id);
  } finally { S.providers.ai.complete = orig; }
  const sections = [{ id: 'a', title: 'Объект: что оценивается' }, { id: 'b', title: 'Выводы' }];
  assert.equal(cleanDraftAnswer(sections, '# Объект\nквартира\n### выводы\nнет'), '# Объект\nквартира\n### выводы\nнет', 'заголовки разного уровня и регистра узнаются');
});

test('Word из черновика: заголовки и абзацы, спецсимволы, лишние управляющие символы — файл читается', async () => {
  const buf = buildReport('## Раздел <1> & «2»\nСтрока\u0001 с символом\n\nИтог', { title: 'Заключение эксперта', number: '№ 1', date: '03.10.2026' });
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const got = (await extractPages(buf, 'Заключение.docx')).pages.join('\n');
  assert.match(got, /1\. Раздел <1> & «2»\nСтрока с символом\nИтог/);
});

test('отчёт Word (2.29): титул, оглавление, нумерованные разделы, таблицы, колонтитул с номером отчёта', async () => {
  assert.deepEqual(parseDraft('## А\n| x | y |\n|---|---|\n| 1 | 2 |\n\nтекст'), [
    { type: 'head', level: 1, text: 'А' }, { type: 'table', rows: [['x', 'y'], ['1', '2']] }, { type: 'para', text: 'текст' },
  ]);
  const text = '## Вводная часть\nОснование — договор.\n| Сведение | Значение |\n| Услуга | Оценка недвижимости |\n## 5. Расчёт\n### Подраздел\nАбзац';
  const buf = buildReport(text, { title: 'Отчёт об оценке', number: '№ AB12CD34', subtitle: 'Оценка недвижимости', org: 'ООО «Тест»', executor: 'Тестовый Эксперт', date: '03.10.2026' });
  const all = (await extractPages(buf, 'Отчёт.docx')).pages.join('\n');
  assert.match(all, /ООО «Тест»[\s\S]*ОТЧЁТ ОБ ОЦЕНКЕ № AB12CD34\nОценка недвижимости[\s\S]*Исполнитель: Тестовый Эксперт\nДата составления: 03\.10\.2026[\s\S]*г\. Москва, 2026/);
  assert.match(all, /Содержание\n1\. Вводная часть\n5\. Расчёт\n5\.1\. Подраздел\n/, 'оглавление — до разделов; номер из заголовка сохраняется');
  assert.match(all, /\n1\. Вводная часть\nОснование — договор\.\nСведение\tЗначение|\n1\. Вводная часть\nОснование — договор\.\nСведение/);
  const zipText = buf.toString('latin1');
  for (const part of ['word/styles.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels']) assert.ok(zipText.includes(part), part);
  const xml = unzipPart(buf, 'word/document.xml');
  assert.match(xml, /<w:tbl>.*Оценка недвижимости.*<\/w:tbl>/s, 'таблица — настоящая таблица Word');
  assert.match(xml, /TOC \\o "1-2"/, 'оглавление — поле Word');
  assert.match(xml, /w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">5\.1\.|Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">5\.1\. Подраздел/);
  assert.match(unzipPart(buf, 'word/footer1.xml'), /Отчёт об оценке № AB12CD34 · стр\. .*PAGE/);
});

// Часть архива Word (для проверок): буфер без сжатия ищем через zlib.
import zlib from 'node:zlib';
function unzipPart(buf, name) {
  let p = buf.length - 22;
  while (buf.readUInt32LE(p) !== 0x06054b50) p -= 1;
  const n = buf.readUInt16LE(p + 10);
  let q = buf.readUInt32LE(p + 16);
  for (let i = 0; i < n; i += 1) {
    const method = buf.readUInt16LE(q + 10); const csize = buf.readUInt32LE(q + 20);
    const nlen = buf.readUInt16LE(q + 28); const xlen = buf.readUInt16LE(q + 30); const clen = buf.readUInt16LE(q + 32);
    const local = buf.readUInt32LE(q + 42);
    if (buf.subarray(q + 46, q + 46 + nlen).toString('utf8') === name) {
      const from = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(from, from + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    q += 46 + nlen + xlen + clen;
  }
  return null;
}

const download = async (c, path) => {
  const r = await fetch(S.base + path, { headers: { cookie: c.cookie } });
  return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
};

test('черновик готовым файлом Word (2.29): скачивает исполнитель; заказчику и посторонним — нет; в шаблоне организации', async () => {
  const o = await inWork('Квартира: Word черновика');
  assert.equal((await download(spec, `/api/orders/${o.id}/draft/docx`)).status, 404, 'черновика ещё нет');
  await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  const w = await download(spec, `/api/orders/${o.id}/draft/docx`);
  assert.equal(w.status, 200);
  assert.equal(w.type, DOCX_MIME);
  assert.match(w.disposition, /filename\*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82/);
  const text = (await extractPages(w.buf, 'Отчёт.docx')).pages.join('\n');
  assert.match(text, /ОТЧЁТ ОБ ОЦЕНКЕ № [0-9A-F]{8}\nОценка недвижимости/);
  assert.match(text, /\n2\. Задание на оценку\nСведение\s*Значение|\n2\. Задание на оценку/);
  assert.match(unzipPart(w.buf, 'word/document.xml'), /<w:tbl>[\s\S]*Адрес объекта[\s\S]*<\/w:tbl>/);
  assert.match(text, /\[заполнить/, 'пометки остаются в файле');
  for (const c of [owner, other, dispatcher]) {
    const r = await download(c, `/api/orders/${o.id}/draft/docx`);
    assert.equal(r.status, c === other ? 404 : 403);
  }

  // Шаблон организации: руководитель загружает, эксперт от этой организации получает черновик в нём.
  const head = await login(S, '+79990000906');
  const org = (await head.req('POST', '/api/orgs', { name: 'ООО «Шаблон-тест»' })).body.org;
  const tpl = makeDocx(['Бланк ООО «Шаблон-тест», ИНН 7700000000', '{{ОТЧЁТ}}', 'Подпись руководителя']);
  const up = (c, buf, name) => c.req('POST', `/api/orgs/${org.id}/template`, buf, { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } });
  let r = await up(head, tpl, 'Бланк.docx');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.template.marked, true);
  // Эксперт без организации в профиле — стандартный Word; вступил и выбрал организацию — в шаблоне.
  await S.sql`insert into org_members (org_id, user_id, role) values (${org.id}, ${spec.user.id}, 'member')`;
  // Организацию в профиле меняют, когда нет дел в работе (2.5а) — здесь ставим напрямую.
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${spec.user.id}`;
  const t = (await extractPages((await download(spec, `/api/orders/${o.id}/draft/docx`)).buf, 'Отчёт.docx')).pages.join('\n');
  assert.match(t, /^Бланк ООО «Шаблон-тест», ИНН 7700000000\n[\s\S]*ОТЧЁТ ОБ ОЦЕНКЕ[\s\S]*Подпись руководителя\n?$/, 'отчёт — на месте {{ОТЧЁТ}}');
  assert.doesNotMatch(t, /\{\{ОТЧЁТ\}\}/);
  // Эксперт видит шаблон и скачивает его, но не меняет; руководитель меняет и убирает.
  const g = (await spec.req('GET', `/api/orgs/${org.id}/template`)).body;
  assert.deepEqual([g.template.filename, g.manage], ['Бланк.docx', false]);
  assert.equal((await spec.req('GET', `/api/orgs/${org.id}/template/file`)).status, 200);
  assert.equal((await up(spec, tpl, 'Мой.docx')).status, 403);
  assert.equal((await spec.req('DELETE', `/api/orgs/${org.id}/template`)).status, 403);
  // Плохие файлы — понятный отказ.
  for (const [buf, name, re] of [
    [tpl, 'Бланк.doc', /\.docx/], [tpl, 'Бланк.docm', /\.docx/], [Buffer.from('PK не архив'), 'Бланк.docx', /не читается/],
    [makeDocx(['Бланк'], { 'word/vbaProject.bin': 'макрос' }), 'Бланк.docx', /макрос/],
  ]) {
    r = await up(head, buf, name);
    assert.equal(r.status, 400, name);
    assert.match(r.body.message, re);
  }
  assert.equal((await up(head, Buffer.alloc(6 * 1024 * 1024, 1), 'Большой.docx')).status, 413);
  // Новый шаблон заменяет прежний; прежний файл уходит из хранилища.
  const [before1] = await S.sql`select storage_key from org_templates where org_id = ${org.id}`;
  r = await up(head, makeDocx(['Новый бланк']), 'Новый.docx');
  assert.equal(r.body.template.marked, false);
  assert.equal(await S.providers.storage.get(before1.storage_key), null);
  const t2 = (await extractPages((await download(spec, `/api/orders/${o.id}/draft/docx`)).buf, 'Отчёт.docx')).pages.join('\n');
  assert.match(t2, /^Новый бланк\n[\s\S]*ОТЧЁТ ОБ ОЦЕНКЕ/, 'без метки — отчёт после содержимого шаблона');
  assert.equal((await head.req('DELETE', `/api/orgs/${org.id}/template`)).status, 204);
  assert.equal((await spec.req('GET', `/api/orgs/${org.id}/template`)).body.template, null);
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${spec.user.id}`;
  await S.sql`update specialists set org_id = null where user_id = ${spec.user.id}`;
});

// Прогон «как настоящий эксперт» (2.33), отчёт «221»: автобус для суда, применён только затратный подход. Раньше черновик
// всё равно писал раздел «11. Сравнительный подход», эксперт его удалял — и в отчёте после раздела 10 сразу 12.
test('подходы к оценке (2.33): черновик без разделов неприменённых подходов, нумерация подряд; аналоги не нужны', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Автобус для суда' })).body.order;
  const fields = { purpose: 'court', region: 'moscow', vehicle_type: 'bus', make_model: 'Авто-Бус 1000-01', year: '2024', vin: 'xxx000000r0000000', reg_number: 'а001аа799', mileage: '12000' };
  const patched = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.order.fields.reg_number, 'А001АА799');
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  // В списке у исполнителя — главное о деле одной строкой; у заказчика этой строки нет.
  const offered = (await spec.req('GET', '/api/orders')).body.orders.find((x) => x.id === o.id);
  assert.equal(offered.brief, 'Для суда · Москва · Автобус · Авто-Бус 1000-01 · 2024 · XXX000000R0000000');
  assert.equal((await owner.req('GET', '/api/orders')).body.orders.find((x) => x.id === o.id).brief, undefined);
  assert.equal((await step(spec, o, 'in_work')).status, 200);

  const before = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body;
  assert.deepEqual(before.approaches.list.map((a) => a.id), ['comparative', 'cost', 'income']);
  assert.equal(before.approaches.chosen, null);
  assert.ok(before.sections.some((x) => x.title.startsWith('11. Сравнительный')));
  // Пустой выбор и чужие подходы — нельзя; диспетчер не выбирает.
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: [] })).status, 400);
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: ['magic'] })).status, 400);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: ['cost'] })).status, 403);
  const r = await spec.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: ['cost', 'cost'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.approaches, ['cost']);
  const titles = r.body.sections.map((x) => x.title);
  assert.ok(!titles.some((t) => /Сравнительный подход/.test(t)), 'раздела неприменённого подхода нет');
  const nums = titles.map((t) => Number(t.match(/^(\d+)\./)?.[1])).filter(Boolean);
  assert.deepEqual(nums, nums.map((_, i) => i + 1), 'нумерация подряд, без пропусков');
  assert.ok(titles.includes('11. Затратный подход (если применяется)'));

  // Черновик: разделы — по выбранным подходам, в таблице подходов сравнительный «Не применялся»; модель знает о выборе.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).status, 201);
  assert.match(lastPrompt(), /Подходы к оценке: применяются — Затратный; не применяются — Сравнительный, Доходный/);
  const body = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft.body;
  assert.ok(!/## 1[12]\. Сравнительный/.test(body));
  assert.match(body, /\| Сравнительный \| Не применялся \| — \|/);
  // Применён один подход (2.66) — его вес сразу 1.
  assert.match(body, /\| Затратный \| \[заполнить\] \| 1 \|/);
  assert.ok(!body.includes(ANALOGS_MARK));

  // Аналоги не нужны — раздел не напоминает о трёх аналогах.
  const an = (await spec.req('GET', `/api/orders/${o.id}/analogs`)).body;
  assert.equal(an.needed, false);
  assert.equal(an.min, 0);
  assert.ok(!an.hints.some((h) => h.startsWith('Нужно не меньше')));
  // Вернул сравнительный — снова нужны.
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: ['comparative', 'cost'] })).status, 200);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/analogs`)).body.needed, true);
});

// Остальные виды оценки (2.43) — как транспорт: поля заявки, разделы отчёта по порядку, подходы, Word.
const OTHER = {
  realty: { title: 'Доля в квартире', fields: { purpose: 'court', region: 'moscow', object_type: 'share', address: 'г. Москва, ул. Долевая, 3, кв. 8', cadastral: '77:01:0001001:1234', area: '64.8', floor: '5 / 9', rooms: '3', year_built: '1975', share_size: '1/3' },
    facts: [/Этаж \/ этажей в доме: 5 \/ 9/, /Год постройки дома: 1975/, /Размер доли \(если оценивается доля\): 1\/3/], last: '14. Литература и приложения', approaches: ['comparative', 'cost'] },
  land: { title: 'Участок ИЖС', fields: { purpose: 'deal', region: 'mo', address: 'МО, д. Тестово, уч. 5', cadastral: '50:20:0010101:77', area: '1200', land_use: 'izhs', land_category: 'settlement', buildings: 'баня' },
    facts: [/Категория земель: Земли населённых пунктов/, /Постройки на участке \(если есть\): баня/], last: '13. Литература и приложения', approaches: ['comparative'] },
  movable: { title: 'Станки цеха', fields: { purpose: 'bank', region: 'mo', items: 'Токарный станок 16К20, 1985 г., 2 шт.', location: 'МО, г. Тестовск, цех 1' },
    facts: [/Что оценить \(перечень\): Токарный станок 16К20/], last: '13. Литература и приложения', approaches: ['comparative', 'cost'] },
  goods: { title: 'Ноутбук сломался', fields: { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться через месяц', questions: 'Есть ли недостаток? Производственный или эксплуатационный?', purchase: '12.03.2026, магазин, 54 990 ₽' },
    facts: [/Когда и где куплен, цена по чеку: 12\.03\.2026/], last: '8. Приложения', approaches: null },
};

for (const [svc, c] of Object.entries(OTHER)) {
  test(`остальные виды (2.43): ${svc} — поля заявки, разделы по порядку без пропусков, подходы, Word`, async () => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: svc, title: c.title })).body.order;
    const r0 = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: c.fields });
    assert.equal(r0.status, 200, JSON.stringify(r0.body));
    assert.equal((await put(owner, o, JPEG, 'общий вид.jpg', 'image/jpeg')).status, 201);
    assert.equal((await step(owner, o, 'matching')).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
    assert.equal((await step(spec, o, 'in_work')).status, 200);
    if (c.approaches) assert.equal((await spec.req('PUT', `/api/orders/${o.id}/approaches`, { approaches: c.approaches })).status, 200);
    const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
    const titles = [...d.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    titles.forEach((t, i) => assert.ok(t.startsWith(`${i + 1}. `), `${svc}: раздел ${i + 1} — «${t}»`));
    assert.equal(titles.at(-1), c.last);
    // Новые поля заявки уходят в модель и попадают в таблицу «Задание» в черновике.
    for (const re of c.facts) {
      assert.match(lastPrompt(), re, `${svc}: поле заявки — в подсказке модели`);
      assert.match(d.body, new RegExp(`\\| ${re.source.replace(/: /, ' \\| ')}`), `${svc}: поле заявки — в таблице «Задание»`);
    }
    assert.match(d.body, /Фото 1 \(общий вид\.jpg\)/, `${svc}: фото — в описании или осмотре`);
    if (c.approaches && !c.approaches.includes('income')) assert.doesNotMatch(d.body, /Доходный подход/, `${svc}: неприменённый подход не пишется`);
    if (svc === 'goods') assert.match(d.body, /## 2\. Вопросы эксперту/);
    const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом');
    assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
    const w = await download(spec, `/api/orders/${o.id}/draft/docx`);
    assert.equal(w.status, 200);
    const text = (await extractPages(w.buf, 'Отчёт.docx')).pages.join('\n');
    assert.match(text, svc === 'goods' ? /ЗАКЛЮЧЕНИЕ ЭКСПЕРТА/ : /ОТЧЁТ ОБ ОЦЕНКЕ/);
    assert.match(text, new RegExp(c.last.replace(/[.()]/g, '\\$&')));
  });
}

test('черновик по своему прошлому делу (2.65): методические разделы — из своего черновика той же услуги, без данных прошлого заказчика и объекта', async () => {
  const sec = (id) => createRegistry().draftSections('expertise', 'realty').find((s) => s.id === id).title;
  const past = await inWork('Прошлая квартира');
  await S.sql`update orders set fields = fields || ${JSON.stringify({ address: 'г. Москва, прошлая ул., 7', area: '61.2' })}::jsonb where id = ${past.id}`;
  const pastBody = [
    `## ${sec('r_standards')}`, 'Оценка выполнена по 135-ФЗ и ФСО I–VI. Заказчик Тестова Заказчица, тел. +7 999 000-09-01, почта zakaz@example.test.',
    `## ${sec('r_assumptions')}`, 'Объект по адресу г. Москва, прошлая ул., 7 площадью 61.2 кв. м оценён по фото; кадастровый номер 77:01:0001001:999.',
    'Стоимость 7 500 000 руб. не учитывает обременения. ИНН заказчика 7700000000.',
    `## ${sec('r_approaches')}`, 'Сравнительный подход применён: рынок квартир в г. Москва развит. Затратный — не применён для квартир.',
    `## ${sec('r_object')}`, 'Квартира по адресу г. Москва, тестовая ул., 9 — прошлый объект, переноситься не должен.',
  ].join('\n');
  assert.equal((await spec.req('PUT', `/api/orders/${past.id}/draft`, { body: pastBody })).status, 200);

  // Чужое прошлое дело той же услуги: исполнитель другой — его черновик эксперту не предлагается и не берётся.
  const spec2 = await login(S, '+79990000907');
  await makeSpecialist(S.sql, spec2.user.id, { permits: [['expertise', 'realty']] });
  const foreign = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Чужое дело' })).body.order;
  await owner.req('PATCH', `/api/orders/${foreign.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS });
  assert.equal((await step(owner, foreign, 'matching')).status, 200);
  await ensurePaid(S.sql, foreign.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${foreign.id}/offer`, { specialist_id: spec2.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec2, foreign, 'in_work')).status, 200);
  assert.equal((await spec2.req('PUT', `/api/orders/${foreign.id}/draft`, { body: pastBody.replace('135-ФЗ', 'ЧУЖОЙ ТЕКСТ') })).status, 200);

  const o = await inWork('Новая квартира');
  const list = (await spec.req('GET', `/api/orders/${o.id}/draft/past`)).body;
  assert.deepEqual(list.sections, [sec('r_standards'), sec('r_assumptions'), sec('r_approaches')]);
  const mine = list.cases.find((c) => c.id === past.id);
  assert.ok(mine, 'своё прошлое дело в списке');
  assert.equal(mine.sections, 3);
  assert.match(mine.ref, /^№ [0-9A-F]{8}$/);
  assert.ok(!list.cases.some((c) => c.id === foreign.id), 'чужое дело не предлагается');
  assert.ok(!list.cases.some((c) => c.id === o.id), 'само дело не предлагается');
  assert.ok(!JSON.stringify(list).includes('Прошлая квартира'), 'без названия и данных прошлого дела');
  // Чужое, несуществующее, само дело — «не найдено»; без черновика — нечего брать.
  for (const id of [foreign.id, o.id, '00000000-0000-0000-0000-000000000000', 'x']) {
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/past`, { past_id: id })).status, 404, id);
  }
  // Черновика нет: заготовка со всеми разделами, таблицами и пометками; методические — из прошлого дела.
  const r = await spec.req('POST', `/api/orders/${o.id}/draft/past`, { past_id: past.id, from: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.draft.body;
  assert.equal(r.body.draft.source, 'past');
  assert.deepEqual(r.body.draft.inputs.past.sections, list.sections);
  assert.ok(r.body.draft.inputs.past.marks >= 7);
  assert.match(b, /Оценка выполнена по 135-ФЗ и ФСО I–VI\./);
  assert.match(b, /Сравнительный подход применён: рынок квартир в г\. Москва развит\./);
  // Взятые разделы — без данных прошлого дела; совпадающее с этим делом (город) остаётся.
  const taken = list.sections.map((t) => b.split(`## ${t}`)[1].split('\n## ')[0]).join('\n');
  assert.match(taken, /по адресу \[заполнить: данные этого дела\] площадью/);
  assert.match(taken, /рынок квартир в г\. Москва развит/, 'город этого же дела остаётся');
  for (const leak of ['+7 999', 'zakaz@', 'прошлая ул', '61.2', '77:01:0001001:999', '7 500 000', '7700000000']) {
    assert.ok(!taken.includes(leak), `данные прошлого дела не перенесены: ${leak}`);
  }
  assert.ok(!b.includes('прошлый объект'), 'разделы без пометки reuse не переносятся');
  assert.match(b, /\[заполнить: данные этого дела\]/);
  assert.match(b, new RegExp(`## ${sec('r_object').replace(/[.()]/g, '\\$&')}\\n\\[заполнить: раздел по этому делу\\]`));
  assert.match(b, /\| Услуга \| /, 'таблица «Задание» — по этому делу');
  const titles = [...b.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(titles, createRegistry().draftSections('expertise', 'realty').map((s) => s.title));
  // «Уже изменился»: брать в устаревший черновик нельзя.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/past`, { past_id: past.id, from: null })).status, 409);
  // Есть черновик ИИ: меняются только методические разделы, остальное — как было.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: r.body.draft.id })).status, 201);
  const ai = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft;
  const objAi = ai.body.split(`## ${sec('r_object')}`)[1].split('\n## ')[0];
  const r2 = await spec.req('POST', `/api/orders/${o.id}/draft/past`, { past_id: past.id, from: ai.id });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.draft.body.split(`## ${sec('r_object')}`)[1].split('\n## ')[0].trim(), objAi.trim());
  assert.match(r2.body.draft.body, /Оценка выполнена по 135-ФЗ/);
  assert.equal(r2.body.draft.versions, 3);
  // Журнал дела — без номера прошлого дела; заказчику черновика нет.
  const [a] = await S.sql`select details from audit_log where action = 'draft.past' and subject_id = ${o.id} order by id desc limit 1`;
  assert.ok(!JSON.stringify(a.details).includes(past.id));
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/draft/past`)).status, 403);
  // Услуга без методических разделов (товароведческая) — пустой список и «нельзя».
  const g = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'goods', title: 'Товар' })).body.order;
  await owner.req('PATCH', `/api/orders/${g.id}`, { deadline: addDays(todayMsk(), 10), fields: OTHER.goods.fields });
  assert.equal((await step(owner, g, 'matching')).status, 200);
  await ensurePaid(S.sql, g.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${g.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, g, 'in_work')).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${g.id}/draft/past`)).body, { sections: [], cases: [] });
  assert.equal((await spec.req('POST', `/api/orders/${g.id}/draft/past`, { past_id: past.id })).status, 400);
});

// Прогон «как эксперт» по строительно-технической (2.79): вопросы суда — в черновик дословно и по номерам, не руками;
// основание с номером и датой; строка о ст. 307 УК РФ; «экспертиза», а не «оценка»; на титуле — «Эксперт».
test('строительно-техническая (2.79): вопросы из заявки дословно, основание суда, ст. 307, «Эксперт» на титуле', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'construction', title: 'Недостатки ремонта' })).body.order;
  const fields = { purpose: 'court', region: 'moscow', object_kind: 'flat', task: 'defects', address: 'г. Москва, ул. Строителей, 30, кв. 12',
    questions: '1. Имеются ли недостатки ремонтных работ в квартире? 2) Какова стоимость их устранения?', area: '62.5' };
  const r0 = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 14), basis_kind: 'court', basis_number: '2-4567/2026', basis_date: '2026-10-01', fields });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const b = await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('%PDF-1.4 определение'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Определение.pdf'), 'x-doc-kind': 'basis' } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  await spec.req('PATCH', '/api/me', { full_name: 'Строителев Степан' });

  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const prompt = lastPrompt();
  assert.match(prompt, /Основание: Определение суда № 2-4567\/2026 от 01\.10\.2026/);
  assert.match(prompt, /Для чего нужна экспертиза: Для суда/);
  assert.doesNotMatch(prompt, /Для чего нужна оценка/);
  assert.match(prompt, /ВОПРОСЫ: программа сама вставит вопросы из заявки дословно в раздел «2\. Вопросы эксперту»/);
  assert.match(d.body, /## 2\. Вопросы эксперту\nНа разрешение эксперта судом \(определение № 2-4567\/2026 от 01\.10\.2026\) поставлены вопросы:\n1\. Имеются ли недостатки ремонтных работ в квартире\?\n2\. Какова стоимость их устранения\?\n\n## 3\./);
  assert.doesNotMatch(d.body, /\[заполнить: вопросы\]/);
  assert.equal(d.body.split(COURT_WARNING).length, 2, 'строка о ст. 307 — один раз');
  assert.ok(d.body.indexOf(COURT_WARNING) < d.body.indexOf('## 2.'), 'ст. 307 — во вводной части');
  assert.match(d.body, /\| Для чего нужна экспертиза \| Для суда \|/);
  assert.match(d.body, /^## 6\. Стоимость устранения недостатков$/m);
  assert.doesNotMatch(d.body, /если спрашивается/);
  // Таблица задания — одна: модель не повторяет её строками «Площадь, кв. м: 62.5».
  assert.doesNotMatch(d.body, /Площадь, кв\. м: 62\.5/);

  // Заготовка без ИИ — те же вопросы и строка о ст. 307; эксперт правит — второй раз не вставляется.
  const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
  const w = await download(spec, `/api/orders/${o.id}/draft/docx`);
  const text = (await extractPages(w.buf, 'Заключение.docx')).pages.join('\n');
  assert.match(text, /ЗАКЛЮЧЕНИЕ ЭКСПЕРТА/);
  assert.match(text, /Эксперт: Строителев Степан/);
  assert.doesNotMatch(text, /Исполнитель: /);
  assert.match(text, /2\. Какова стоимость их устранения\?/);
  assert.equal(text.split('статье 307 Уголовного кодекса').length, 2);
});

test('вопросы из заявки (2.79): нумерация заказчика заменяется своей; строки и «1. … 2) …» в одну строку', () => {
  assert.deepEqual(splitQuestions('1. Есть ли трещины? 2. Какова причина? 3) Сколько стоит?'), ['Есть ли трещины?', 'Какова причина?', 'Сколько стоит?']);
  assert.deepEqual(splitQuestions('Есть ли трещины?\n\n2. Какова причина?'), ['Есть ли трещины?', 'Какова причина?']);
  assert.deepEqual(splitQuestions('Есть ли недостаток? Производственный или эксплуатационный?'), ['Есть ли недостаток? Производственный или эксплуатационный?']);
  assert.deepEqual(splitQuestions('  '), []);
  // Описание модуля: своя подпись — только у общего поля; таблица вопросов — только где есть поле questions.
  const svc = (patch) => ({ ...expertise, services: expertise.services.map((s) => (s.id === 'construction' ? { ...s, ...patch } : s)) });
  assert.throws(() => validateModule(svc({ labels: { address: 'Адрес' } })), /не общее поле/);
  assert.throws(() => validateModule(svc({ labels: { purpose: '' } })), /подпись поля purpose/);
  assert.throws(() => validateModule({ ...expertise, draft: [...expertise.draft, { id: 'x_q', title: 'Вопросы', services: ['realty'], table: 'questions' }] }), /нет поля questions/);
  const reg = createRegistry([expertise]);
  assert.equal(reg.service('expertise', 'construction').fields.find((f) => f.id === 'purpose').label, 'Для чего нужна экспертиза');
  assert.equal(reg.service('expertise', 'realty').fields.find((f) => f.id === 'purpose').label, 'Для чего нужна оценка');
  assert.equal(reg.catalog()[0].services.find((s) => s.id === 'goods').fields.find((f) => f.id === 'purpose').label, 'Для чего нужна экспертиза');
});

// Прогон «как эксперт» по почерковедческой (2.81): документы, которые представил заказчик (основание и присланные по
// запросу эксперта), — списком под таблицей задания; вопросы суда — только в своём разделе, не строкой таблицы; «где
// находится документ»; по ссылке снимают документ. Фото осмотра и результат в список не попадают.
test('почерковедческая (2.81): документы заказчика под таблицей задания, вопросы без повтора, съёмка документа', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'handwriting', title: 'Подпись в расписке' })).body.order;
  const fields = { purpose: 'court', region: 'moscow', object_kind: 'signature', document: 'расписка от 12.03.2025', original: 'yes', samples: 'free',
    questions: 'Кем выполнена подпись в расписке от 12.03.2025?' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 21), basis_kind: 'court', basis_number: '2-8811/2026', basis_date: '2026-10-02', fields })).status, 200);
  const up = (c, name, kind) => c.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(`%PDF-1.4 ${name}`), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name), ...(kind ? { 'x-doc-kind': kind } : {}) } });
  assert.equal((await up(owner, 'Определение.pdf', 'basis')).status, 201);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const view = (await spec.req('GET', `/api/orders/${o.id}`)).body.order;
  assert.equal(view.subject, 'document');
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.order.subject, 'document');

  const asked = (await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['disputed_doc', 'free_samples'] })).body.requests;
  const doc = (await up(owner, 'Расписка.pdf')).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${asked.find((r) => r.item_id === 'disputed_doc').id}/attach`, { document_id: doc.id })).status, 200);

  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const day = todayMsk().split('-').reverse().join('.');
  assert.ok(d.body.includes(`Документы, представленные заказчиком:\n1. Документ-основание — файл «Определение.pdf», получен ${day}\n2. Копия исследуемого документа — файл «Расписка.pdf», получен ${day}`), d.body);
  assert.doesNotMatch(d.body, /\| Какие вопросы поставить эксперту \|/);
  assert.equal(d.body.split('Кем выполнена подпись').length, 2, 'вопрос — один раз, в своём разделе');
  assert.match(d.body, /\| Где находится документ \| Москва \|/);
  assert.match(lastPrompt(), /список документов заказчика под таблицей задания программа тоже вставит сама/);

  // Оценка квартиры: вопросов-раздела нет — строка «вопросы» в таблице не пропадает; ссылка осмотра — про объект.
  const reg = createRegistry([expertise]);
  assert.equal(reg.service('expertise', 'realty').service.subject, undefined);
  assert.equal(reg.service('expertise', 'handwriting').fields.find((f) => f.id === 'region').label, 'Где находится документ');
  const svc = (patch) => ({ ...expertise, services: expertise.services.map((s) => (s.id === 'handwriting' ? { ...s, ...patch } : s)) });
  assert.throws(() => validateModule(svc({ subject: 'paper' })), /subject — только 'document'/);
});
