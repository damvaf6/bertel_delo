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
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty'], ['expertise', 'vehicle'], ['expertise', 'land'], ['expertise', 'movable'], ['expertise', 'goods'], ['expertise', 'construction'], ['expertise', 'handwriting'], ['expertise', 'car_damage']] });
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
  // Повторная оценка (2.118) берёт разделы черновика — без черновика её описание тоже убирается.
  const { draft, repeat, ...noDraft } = structuredClone(expertise);
  assert.ok(repeat.length);
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
  const final = d1.body.replace(ANALOGS_MARK, '| № | Аналог |\n| 1 | эксперт вписал сам |').replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'Эксперт: заполнено вручную') + '\nИтоговая стоимость: 15 000 000 руб. Договор № 9/2026.';
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
  // Ущерб после ДТП (2.97): заключение о стоимости ремонта — без подходов к оценке и аналогов.
  car_damage: { title: 'Ущерб после ДТП', fields: { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, accident_date: '14.09.2026', damage: 'Задний бампер, крышка багажника', method: 'osago', insurer: 'Тест-Страх, убыток 123, выплачено 41 000 ₽' },
    facts: [/Дата ДТП: 14\.09\.2026/, /Что повреждено: Задний бампер/, /Как считать ремонт: По Единой методике/], last: '10. Приложения', approaches: null },
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
    if (svc === 'goods' || svc === 'car_damage') assert.match(d.body, /## 2\. Вопросы эксперту/);
    if (svc === 'car_damage') assert.doesNotMatch(d.body, /Сравнительный подход|аналог/i, 'ущерб после ДТП — без подходов и аналогов');
    const filled = d.body.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом');
    assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled, from: d.id })).status, 200);
    const w = await download(spec, `/api/orders/${o.id}/draft/docx`);
    assert.equal(w.status, 200);
    const text = (await extractPages(w.buf, 'Отчёт.docx')).pages.join('\n');
    assert.match(text, ['goods', 'car_damage'].includes(svc) ? /ЗАКЛЮЧЕНИЕ ЭКСПЕРТА/ : /ОТЧЁТ ОБ ОЦЕНКЕ/);
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
  assert.throws(() => validateModule(svc({ subject: 'paper' })), /subject — 'document', 'goods' или 'car'/);
  // Товароведческая (2.82): снимают товар; «где находится» — товар, адрес — отдельной строкой без повтора подписи.
  const goods = reg.service('expertise', 'goods');
  assert.equal(goods.service.subject, 'goods');
  assert.equal(goods.fields.find((f) => f.id === 'region').label, 'Где находится товар');
  assert.equal(goods.fields.filter((f) => f.label === 'Где находится товар').length, 1);
  assert.ok(!expertise.request_docs.find((d) => d.id === 'damage_docs').services.includes('goods'), 'протокол ДТП и акт о заливе — не для товара');
  // Ущерб после ДТП (2.97): своя услуга — заключение о ремонте, а не рыночная стоимость машины.
  const crash = reg.service('expertise', 'car_damage');
  assert.equal(crash.service.paper, 'Заключение эксперта');
  assert.equal(crash.fields.find((f) => f.id === 'purpose').label, 'Для чего нужна экспертиза');
  assert.equal(crash.fields.find((f) => f.id === 'region').label, 'Где находится автомобиль');
  assert.equal(reg.analogs('expertise', 'car_damage'), null, 'аналоги не нужны');
  assert.ok(!reg.approachesFor('expertise', 'car_damage'), 'подходы к оценке не выбираются');
  const docs = reg.requestDocs('expertise', 'car_damage').map((d) => d.id);
  for (const id of ['sts', 'pts', 'accident_docs', 'insurer_docs', 'repair_docs']) assert.ok(docs.includes(id), id);
  assert.ok(!docs.includes('damage_docs') && !docs.includes('encumbrance'), 'акт о заливе и залог — не для ущерба после ДТП');
  const steps = reg.inspectionSteps('expertise', 'car_damage');
  assert.ok(steps.find((x) => x.id === 'car_damage_close' && !x.optional), 'повреждения крупно — обязательный шаг');
  assert.ok(steps.some((x) => x.id === 'car_vin') && !steps.some((x) => x.id === 'defects'));
  const checks = reg.checks('expertise', 'car_damage').map((c) => c.id);
  for (const id of ['vehicle_identity', 'cd_damage', 'cd_cost', 'expert_info', 'conclusions', 'questions_answered']) assert.ok(checks.includes(id), id);
  assert.ok(!checks.includes('analogs') && !checks.includes('approaches') && !checks.includes('appraiser'));
});

// Перечень использованных документов (2.95): программа собирает его из дела — документы заказчика (и присланные по запросу),
// досье эксперта, фото осмотра, аналоги со ссылкой и временем скриншота; эксперт правит; «Обновить перечень» — заново.
test('перечень использованных документов (2.95): из дела, сквозная нумерация; обновление не трогает остальной текст', async () => {
  const o = await inWork('Квартира с перечнем');
  const appendix = createRegistry().draftSections('expertise', 'realty').find((s) => s.sources);
  assert.equal(appendix.id, 'r_appendix');
  for (const svc of ['realty', 'land', 'movable', 'vehicle', 'car_damage', 'goods', 'construction', 'handwriting']) {
    assert.equal(createRegistry().draftSections('expertise', svc).filter((s) => s.sources).length, 1, svc);
  }
  assert.equal((await spec.req('POST', '/api/specialist/me/dossier', { kind: 'sro', title: 'СРО «Тестовые оценщики»', number: '7777' })).status, 201);
  const [a1] = await S.sql`insert into order_analogs (order_id, author_id, url, url_key, confirmed_at, received_at)
                           values (${o.id}, ${spec.user.id}, 'https://www.avito.ru/moskva/kvartiry/1', 'a1', now(), '2026-10-01T09:30:00Z') returning id`;
  await S.sql`insert into order_analogs (order_id, author_id, url, url_key, confirmed_at) values (${o.id}, ${spec.user.id}, 'https://cian.ru/sale/2', 'a2', now())`;
  await S.sql`insert into order_analogs (order_id, author_id, url, url_key) values (${o.id}, ${spec.user.id}, 'https://cian.ru/sale/neutverzhdyon', 'a3')`;
  for (const n of [1, 2]) {
    await S.sql`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind, created_at)
                values (${o.id}, ${owner.user.id}, ${`осмотр-${n}.jpg`}, 'image/jpeg', 6, ${`k-${o.id}-${n}`}, 'inspection', '2026-10-05T10:00:00Z')`;
  }

  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.match(lastPrompt(), /ПЕРЕЧЕНЬ ДОКУМЕНТОВ: программа сама вставит в раздел «15\. Литература и приложения»/);
  const part = d.body.split(`## ${appendix.title}`)[1].split('\n## ')[0];
  const day = todayMsk().split('-').reverse().join('.');
  const block = part.split('Перечень использованных документов')[1].split('\n\n')[0];
  assert.ok(block.includes(`Документы, представленные заказчиком:\n1. Документ — файл «фасад.jpg», получен ${day}`), block);
  assert.ok(block.includes('3. Документ — файл «Сведения.docx»'), block);
  assert.ok(block.includes('Документы эксперта:\n4. Членство в СРО: СРО «Тестовые оценщики», номер в реестре 7777'), block);
  assert.ok(block.includes('Материалы осмотра:\n5. Фотоматериалы осмотра — 2 снимка, получены платформой «БЕРТЕЛ Дело» 05.10.2026'), block);
  assert.ok(block.includes('Объявления-аналоги:\n6. Аналог 1 — avito.ru: https://www.avito.ru/moskva/kvartiry/1, скриншот получен 01.10.2026, 12:30 (МСК)'), block);
  assert.ok(block.includes('7. Аналог 2 — cian.ru: https://cian.ru/sale/2, скриншот не приложен'), block);
  assert.ok(!block.includes('neutverzhdyon'), 'неподтверждённый аналог — не в перечне');
  assert.equal(d.body.split('Перечень использованных документов').length, 2, 'перечень — один раз');

  // Эксперт правит перечень и текст раздела; потом заказчик присылает документ, аналог убран — «Обновить перечень».
  const edited = d.body.replace('7. Аналог 2', '7. Аналог второй').replace(/(## 15\. Литература и приложения\n)/, '$1Мой абзац о литературе.\n');
  const saved = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: edited, from: d.id })).body.draft;
  assert.equal((await put(owner, o, Buffer.from('%PDF-1.4 егрн'), 'ЕГРН.pdf', 'application/pdf')).status, 201);
  await S.sql`update order_analogs set deleted_at = now() where id = ${a1.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/sources`, { from: d.id })).status, 409, 'уже изменился');
  const r = await spec.req('POST', `/api/orders/${o.id}/draft/sources`, { from: saved.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items, 7);
  const b = r.body.draft.body;
  assert.equal(r.body.draft.versions, saved.versions + 1);
  assert.match(b, /Мой абзац о литературе\./, 'текст эксперта вне перечня не тронут');
  assert.match(b, /4\. Документ — файл «ЕГРН\.pdf»/);
  assert.match(b, /7\. Аналог 1 — cian\.ru: https:\/\/cian\.ru\/sale\/2/);
  assert.ok(!b.includes('avito.ru'), 'убранный аналог ушёл из перечня');
  assert.ok(!b.includes('Аналог второй'), 'перечень собран заново');
  assert.equal(b.split('Перечень использованных документов').length, 2);
  // Второе нажатие — ничего не изменилось, новой версии нет.
  const again = await spec.req('POST', `/api/orders/${o.id}/draft/sources`, { from: r.body.draft.id });
  assert.equal(again.body.draft.versions, r.body.draft.versions);
  // Эксперт удалил перечень целиком — обновление вставит его снова под заголовок раздела.
  const without = b.replace(/Перечень использованных документов[^]*?\n\n/, '');
  const s2 = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: without, from: r.body.draft.id })).body.draft;
  assert.ok(!s2.body.includes('Перечень использованных'));
  const back = (await spec.req('POST', `/api/orders/${o.id}/draft/sources`, { from: s2.id })).body.draft;
  assert.match(back.body, /## 15\. Литература и приложения\nПеречень использованных документов/);
  // Заказчику и диспетчеру — нельзя; в журнале дела — отметка.
  for (const c of [owner, dispatcher]) assert.equal((await c.req('POST', `/api/orders/${o.id}/draft/sources`, { from: back.id })).status, 403);
  const [j] = await S.sql`select count(*)::int as n from audit_log where action = 'draft.sources' and subject_id = ${o.id}`;
  assert.equal(j.n, 2);
  // Word: перечень — нумерованные строки в разделе приложений.
  const word = await download(spec, `/api/orders/${o.id}/draft/docx`);
  assert.equal(word.status, 200);
  const text = (await extractPages(word.buf, 'Отчёт.docx')).pages.join('\n');
  assert.match(text, /Фотоматериалы осмотра — 2 снимка/);
});

test('что изменилось между версиями черновика (2.104): по разделам добавленные и убранные абзацы, к любой прошлой версии', async () => {
  const diff = (await import('../../src/docs/diff.mjs')).draftDiff;
  // Чистая разница: раздел перенумерован (лишние пробелы не в счёт), переставленный абзац, раздел добавлен и убран целиком, текст до заголовков.
  const a = 'Вступление\n## 1. Задание\nОбъект: квартира\nЦель: суд\n\n## 2. Описание\nЭтаж 5\nРемонт 2020\n## 3. Лишнее\nУбрать';
  const b = 'Вступление\n## 2. ЗАДАНИЕ\nОбъект:   квартира\nЦель: суд\n## 2. Описание\nРемонт 2020\nЭтаж 5\n## 4. Выводы\nИтог 15 млн';
  const d = diff(a, b);
  assert.deepEqual(d.sections.map((s) => [s.title, s.status]), [['2. ЗАДАНИЕ', 'renamed'], ['2. Описание', 'changed'], ['4. Выводы', 'added'], ['3. Лишнее', 'removed']]);
  assert.equal(d.sections[0].was_title, '1. Задание');
  assert.deepEqual([d.sections[0].added, d.sections[0].removed], [[], []]);
  assert.equal(d.sections[1].added.length + d.sections[1].removed.length, 2, 'переставленный абзац — убран и добавлен');
  assert.deepEqual(d.sections[2].added, ['Итог 15 млн']);
  assert.deepEqual(d.sections[3].removed, ['Убрать']);
  assert.equal(diff(a, a).sections.length, 0, 'без изменений — пусто');
  assert.deepEqual(diff('', 'Строка').sections, [{ title: 'Начало текста', was_title: null, status: 'added', added: ['Строка'], removed: [] }]);

  const o = await inWork('Квартира: версии черновика');
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}/draft/versions`)).body.versions, [], 'черновика нет — версий нет');
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/draft/diff?from=1`)).status, 404);
  const d1 = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const head = d1.body.match(/^## .+$/m)[0];
  const v2 = d1.body.replace(head, `${head}\nЭксперт добавил абзац`);
  const d2 = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: v2, from: d1.id })).body.draft;
  const d3 = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: v2.replace('Эксперт добавил абзац', 'Эксперт поправил абзац'), from: d2.id })).body.draft;

  const vs = (await spec.req('GET', `/api/orders/${o.id}/draft/versions`)).body.versions;
  assert.deepEqual(vs.map((v) => [v.id, v.source, v.mine]), [[d3.id, 'edit', true], [d2.id, 'edit', true], [d1.id, 'ai', true]]);
  assert.ok(vs[0].chars > 100);
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/draft/versions`)).body.versions[0].mine, false);

  // От версии ИИ к текущей — одна добавленная строка в первом разделе.
  let r = (await spec.req('GET', `/api/orders/${o.id}/draft/diff?from=${d1.id}`)).body;
  assert.deepEqual([r.from.id, r.to.id, r.added, r.removed], [d1.id, d3.id, 1, 0]);
  assert.deepEqual(r.sections, [{ title: head.replace(/^##\s*/, ''), was_title: null, status: 'changed', added: ['Эксперт поправил абзац'], removed: [] }]);
  // Между двумя прошлыми версиями — свой отрезок; в обратную сторону — добавленное становится убранным.
  r = (await spec.req('GET', `/api/orders/${o.id}/draft/diff?from=${d2.id}&to=${d3.id}`)).body;
  assert.deepEqual([r.sections[0].added, r.sections[0].removed], [['Эксперт поправил абзац'], ['Эксперт добавил абзац']]);
  r = (await spec.req('GET', `/api/orders/${o.id}/draft/diff?from=${d3.id}&to=${d1.id}`)).body;
  assert.deepEqual([r.added, r.removed], [0, 1]);
  // Версия другого дела или мусор — «не найдено»; диспетчер смотрит тоже.
  const other = await inWork('Квартира: чужая версия');
  const od = (await spec.req('POST', `/api/orders/${other.id}/draft/ai`, {})).body.draft;
  for (const q of [`from=${od.id}`, `from=${d1.id}&to=${od.id}`, 'from=abc', 'from=', `from=${d1.id}&to=1x`]) {
    assert.equal((await spec.req('GET', `/api/orders/${o.id}/draft/diff?${q}`)).status, 404, q);
  }
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/draft/diff?from=${d1.id}`)).body.added, 1);
});

// 2.177: перед сборкой Word — какие разделы ещё пустые (тот же модуль, что на странице, public/draftempty.js).
test('пустые разделы черновика: только пометки — пустой, подразделы — нет, текст под заголовком — нет', async () => {
  const { emptySections } = await import('../../public/draftempty.js');
  const body = [
    '## 1. Задание на оценку', 'Основание: договор', '',
    '## 2. Допущения', '[заполнить: раздел по этому делу]', '',
    '## 3. Расчёт', '', '### 3.1 Сравнительный подход', '[заполнить: расчёт и итоговая величина]',
    '### 3.2 Затратный подход', 'Не применялся.', '',
    '## 4. Описание объекта', 'Фото 1 (кухня): [описать по фото: кухня]', '',
    '## 5. Выводы',
  ].join('\n');
  const list = emptySections(body);
  assert.deepEqual(list.map((s) => s.title), ['2. Допущения', '3.1 Сравнительный подход', '5. Выводы']);
  // Положение — начало и конец строки заголовка: по ним страница ставит курсор в раздел.
  for (const s of list) assert.equal(body.slice(s.at, s.end), `${body.slice(s.at).startsWith('###') ? '###' : '##'} ${s.title}`);
  assert.deepEqual(emptySections('Текст без заголовков'), []);
  assert.deepEqual(emptySections(''), []);
  assert.deepEqual(emptySections(null), []);
});

// 2.229: «Исправить в черновике» у находки по выписке ЕГРН — место значения в тексте черновика (public/draftfind.js).
test('2.229: место в черновике для находки по выписке ЕГРН: число и текст целиком, похожая строка, короткое число без строки — нет', async () => {
  const { findInDraft } = await import('../../public/draftfind.js');
  const body = [
    '## 1. Задание на оценку', '| Площадь, кв. м | 145,1 |', 'Кадастровый номер 77:01:0001001:12345',
    '## 2. Описание объекта', 'Квартира общей площадью 45.1 кв. м расположена на 5 этаже 9-этажного дома.',
    'Год постройки 1975, стены — кирпичные.', 'Расчёт: 5 аналогов, корректировка 5 %.',
  ].join('\n');
  const at = (bad, quote) => { const r = findInDraft(body, { bad, quote }); return r && body.slice(r.from, r.to); };
  // «45,1» = «45.1», но не часть «145,1»; кадастровый номер — не часть более длинного.
  assert.equal(at('45,1', 'Общей площадью 45,1 кв. м'), '45.1');
  assert.equal(at('77:01:0001001:1234', 'кадастровый номер 77:01:0001001:1234'), null);
  // Этаж «5» встречается трижды — берётся строка, похожая на строку отчёта; без похожей строки — не ищется.
  const five = findInDraft(body, { bad: '5', quote: 'Квартира расположена на 5 этаже' });
  assert.equal(body.slice(five.from, five.to), '5');
  assert.match(body.slice(body.lastIndexOf('\n', five.from) + 1, five.to), /^Квартира общей площадью/);
  assert.equal(findInDraft(body, { bad: '5', quote: 'Этаж: 5' }), null);
  // Год и материал стен — целым словом, без учёта регистра.
  assert.equal(at('1975', 'Год постройки 1975'), '1975');
  assert.equal(at('Кирпичные', 'Материал стен: кирпичные'), 'кирпичные');
  assert.equal(at('кирпич', 'стены кирпич'), null);
  assert.equal(findInDraft(body, { bad: '' }), null);
  assert.equal(findInDraft('', { bad: '45,1' }), null);
});

// 2.232: «Заменить на значение из выписки» — чем заменить (public/draftfind.js): разделитель — как в тексте; несколько годов
// и материал стен словом — одной кнопкой не заменяются.
test('2.232: замена на значение из выписки: число с разделителем текста, номер и адрес как есть, год «или» и материал — нет', async () => {
  const { swapValue } = await import('../../public/draftfind.js');
  assert.equal(swapValue({ bad: '45,1', right: '47,3' }, '45,1'), '47,3');
  assert.equal(swapValue({ bad: '45,1', right: '47,3' }, '45.1'), '47.3');
  assert.equal(swapValue({ bad: '45,1', right: '47,3' }), '47,3');
  assert.equal(swapValue({ bad: '77:01:0001001:1234', right: '77:01:0001001:4321' }, '77:01:0001001:1234'), '77:01:0001001:4321');
  assert.equal(swapValue({ bad: '5', right: '6' }, '5'), '6');
  assert.equal(swapValue({ bad: 'г. Москва, ул. Тестовая, д. 9, кв. 12', right: 'г. Москва,  ул. Тестовая, д. 9, кв. 21' }), 'г. Москва, ул. Тестовая, д. 9, кв. 21');
  assert.equal(swapValue({ bad: '1975', right: '1984' }, '1975'), '1984');
  assert.equal(swapValue({ bad: '1975', right: '1984 или 1985' }, '1975'), null);
  assert.equal(swapValue({ bad: 'кирпичный', right: 'Панельные' }, 'кирпичный'), null);
  assert.equal(swapValue({ bad: '45,1', right: '' }), null);
  // 2.260: назначение (2.259) — «нежилое» ↔ «жилое» в той же форме и с той же заглавной, что в тексте черновика.
  assert.equal(swapValue({ bad: 'нежилое', right: 'жилое', flip: 'не' }, 'нежилое'), 'жилое');
  assert.equal(swapValue({ bad: 'нежилое', right: 'жилое', flip: 'не' }, 'Нежилого'), 'Жилого');
  assert.equal(swapValue({ bad: 'жилое', right: 'нежилое', flip: 'не' }, 'Жилое'), 'Нежилое');
  assert.equal(swapValue({ bad: 'жилом', right: 'нежилом', flip: 'не' }), 'нежилом');
  assert.equal(swapValue({ bad: 'нежилое', right: 'жилое' }, 'нежилое'), null);
  assert.equal(swapValue(null), null);
});

// 2.274: «Заменить на значение из задания» — дата оценки в той же записи, что в тексте черновика.
test('2.274: замена даты оценки на дату из задания — цифрами и словами, как в тексте', async () => {
  const { swapValue, findInDraft } = await import('../../public/draftfind.js');
  const g = { bad: '01.10.2026', right: '03.10.2026', from: 'в задании на оценку «Задание.txt»' };
  assert.equal(swapValue(g, '01.10.2026'), '03.10.2026');
  assert.equal(swapValue(g, '«01» октября 2026'), '«03» октября 2026');
  assert.equal(swapValue(g, '1 октября 2026'), '3 октября 2026');
  assert.equal(swapValue({ ...g, right: '15.11.2026' }, '1 октября 2026'), '15 ноября 2026');
  assert.equal(swapValue(g), '03.10.2026');
  const body = 'Дата оценки — «01» октября 2026 г.';
  const at = findInDraft(body, { bad: g.bad, quote: 'Дата оценки: 01.10.2026' });
  const now = swapValue(g, body.slice(at.from, at.to));
  assert.equal(body.slice(0, at.from) + now + body.slice(at.to), 'Дата оценки — «03» октября 2026 г.');
});

// 2.246: «Заменить всё по выписке» — все замены одним проходом (public/draftfind.js); отмена — где значение ещё на месте.
test('2.246: заменить всё по выписке: замены одним проходом, нет в тексте и год «или» — пропущены, отмена по месту', async () => {
  const { swapAll, unswapAll } = await import('../../public/draftfind.js');
  const body = 'Кадастровый номер 77:01:0001001:1234.\nОбщей площадью 45,1 кв. м по техпаспорту.\nГод постройки 1975.\nЭтажей 5';
  const items = [
    { g: { bad: '45,1', right: '47.3' }, quote: 'Общей площадью 45,1 кв. м' },
    { g: { bad: '77:01:0001001:1234', right: '77:01:0001001:4321' } },
    { g: { bad: '1975', right: '1984 или 1985' } },
    { g: { bad: '99,9', right: '47,3' } },
    { g: { bad: '45,1', right: '47,3' }, quote: 'площадью' }, // то же место — второй раз не заменяется
  ];
  const r = swapAll(body, items);
  assert.equal(r.body, 'Кадастровый номер 77:01:0001001:4321.\nОбщей площадью 47,3 кв. м по техпаспорту.\nГод постройки 1975.\nЭтажей 5');
  assert.deepEqual(r.done.map((d) => [d.i, d.was, d.now]), [[1, '77:01:0001001:1234', '77:01:0001001:4321'], [0, '45,1', '47,3']]);
  for (const d of r.done) assert.equal(r.body.slice(d.from, d.from + d.now.length), d.now);
  assert.deepEqual(r.missing, [2, 3, 4]);
  // Отмена всего — исходный текст.
  assert.deepEqual(unswapAll(r.body, r.done), { body, undone: [1, 0], kept: [] });
  // Номер уже правили руками — его не трогаем, площадь возвращаем.
  const edited = r.body.replace('77:01:0001001:4321', '77:01:0001001:5555');
  const u = unswapAll(edited, r.done);
  assert.deepEqual([u.undone, u.kept], [[0], [1]]);
  assert.match(u.body, /:5555\.\nОбщей площадью 45,1 кв\. м/);
  assert.deepEqual(swapAll('', items), { body: '', done: [], missing: [0, 1, 2, 3, 4] });
});

test('2.207: дата оценки из приложенного задания на оценку — в таблицу задания, модели и вместо пометки; разные даты — эксперт выбирает сам', async () => {
  const o = await inWork('Квартира: дата оценки в черновик');
  const putDoc = (body, name, kind) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), ...(kind ? { 'x-doc-kind': kind } : {}) } });
  // Без задания — ничего не подставляется.
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.equal(d.inputs.value_date, null);
  assert.doesNotMatch(d.body, /\| Дата оценки \|/);
  assert.equal((await putDoc('ЗАДАНИЕ НА ОЦЕНКУ\nОбъект: квартира\nДата оценки: 03.10.2026', 'Задание на оценку.txt', 'basis')).status, 201);
  // Выписка с кадастровой стоимостью «по состоянию на» — не дата оценки.
  assert.equal((await putDoc('Кадастровая стоимость по состоянию на 01.01.2026 — 7 000 000 руб.', 'Выписка ЕГРН.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.value_date, { day: '03.10.2026', name: 'Задание на оценку.txt', page: 1, what: 'в задании на оценку' });
  assert.match(d.body, /## 2\. Задание на оценку\n\| Сведение \| Значение \|\n\| Услуга \| Оценка недвижимости \|\n\| Основание \|[^\n]*\|\n\| Дата оценки \| 03\.10\.2026 \|\n/);
  assert.match(lastPrompt(), /Дата оценки: 03\.10\.2026 \(в задании на оценку «Задание на оценку\.txt», стр\. 1\)/);
  assert.match(d.body, /\nДата оценки: 03\.10\.2026\n/);
  // Модель всё же оставила пометку про дату оценки — программа ставит дату; другие пометки не трогает.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nДата оценки — [заполнить: дата оценки]. Стоимость — [заполнить: расчёт]\n## 2. Задание на оценку\nДату оценки: [заполнить: дату оценки из задания]', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
    assert.match(d.body, /Дата оценки — 03\.10\.2026\. Стоимость — \[заполнить: расчёт\]/);
    assert.match(d.body, /Дату оценки: 03\.10\.2026/);
  } finally { S.providers.ai.complete = orig; }
  // Правка эксперта сохраняет, откуда дата.
  const saved = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: `${d.body}\nправка`, from: d.id })).body.draft;
  assert.equal(saved.inputs.value_date.day, '03.10.2026');
  // Новое задание с другой датой рядом со старым — дата не подставляется, эксперту — обе даты.
  assert.equal((await putDoc('ЗАДАНИЕ НА ОЦЕНКУ (уточнённое)\nДата оценки: 05.10.2026', 'Задание новое.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: saved.id })).body.draft;
  assert.deepEqual(d.inputs.value_date, { days: ['05.10.2026', '03.10.2026'] });
  assert.doesNotMatch(d.body, /\| Дата оценки \|/);
  assert.doesNotMatch(lastPrompt(), /Дата оценки: [\d.]+ \(/, 'даты в модель — только текстом самих документов');
});

test('2.211: площадь и кадастровый номер из выписки ЕГРН — в таблицу задания, модели и вместо пометок; разные значения — эксперт выбирает сам', async () => {
  const o = await inWork('Квартира: площадь и номер из выписки в черновик');
  const putDoc = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  // Без выписки — как заполнил заказчик.
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.equal(d.inputs.egrn, null);
  assert.match(d.body, /\| Площадь, кв\. м \| 54,3 \|/);
  // Выписка на участок под домом при оценке квартиры — не в счёт.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Земельный участок\nКадастровый номер: 77:01:0001001:10\nПлощадь: 1500 кв. м', 'Выписка ЕГРН участок.txt')).status, 201);
  assert.equal((await putDoc('Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПлощадь, м2: 47,3', 'Выписка ЕГРН.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.egrn, {
    area: { v: '47,3', name: 'Выписка ЕГРН.txt', page: 1, typed: '54,3' },
    cadastral: { v: '77:01:0001001:4321', name: 'Выписка ЕГРН.txt', page: 1, typed: null },
    floor: null,
    address: null,
    rights: null,
    share_size: null,
    use: null,
  });
  assert.match(d.body, /\| Кадастровый номер \| 77:01:0001001:4321 \(по выписке ЕГРН\) \|/);
  assert.match(d.body, /\| Площадь, кв\. м \| 47,3 \(по выписке ЕГРН; в заявке — 54,3\) \|/);
  assert.match(lastPrompt(), /Площадь объекта по выписке ЕГРН: 47,3 кв\. м \(выписка «Выписка ЕГРН\.txt», стр\. 1\)/);
  assert.match(lastPrompt(), /Кадастровый номер по выписке ЕГРН: 77:01:0001001:4321/);
  // Модель оставила пометки — программа ставит значения из выписки; «кв. м» не задваивается; другие пометки не трогает.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nОбщая площадь — [заполнить: площадь] кв. м, кадастровый номер [заполнить: кадастровый номер]. Стоимость — [заполнить: расчёт]\n## 2. Задание на оценку\nПлощадь: [заполнить: общую площадь объекта]', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
    assert.match(d.body, /Общая площадь — 47,3 кв\. м, кадастровый номер 77:01:0001001:4321\. Стоимость — \[заполнить: расчёт\]/);
    assert.match(d.body, /Площадь: 47,3 кв\. м/);
  } finally { S.providers.ai.complete = orig; }
  // Правка эксперта сохраняет, откуда значения.
  const saved = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: `${d.body}\nправка`, from: d.id })).body.draft;
  assert.equal(saved.inputs.egrn.area.v, '47,3');
  // Вторая выписка на тот же объект с другой площадью — площадь не подставляется, номер — да.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПлощадь, м2: 47,8', 'Выписка ЕГРН новая.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: saved.id })).body.draft;
  assert.deepEqual(d.inputs.egrn.area, { values: ['47,8', '47,3'] });
  assert.equal(d.inputs.egrn.cadastral.v, '77:01:0001001:4321');
  assert.match(d.body, /\| Площадь, кв\. м \| 54,3 \|/);
  assert.doesNotMatch(lastPrompt(), /Площадь объекта по выписке ЕГРН/);
  // Выписок нет — ничего не подставляется.
  const { egrnFacts } = await import('../../src/ai/report-checks.mjs');
  assert.deepEqual(egrnFacts([], { service: 'realty' }), { area: null, cadastral: null, floor: null, floors: null, address: null });
});

test('2.243: правообладатель, вид права и обременения из выписки ЕГРН — в таблицу задания, модели и вместо пометок; несколько видов права — эксперт выбирает сам', async () => {
  const o = await inWork('Квартира: права и обременения из выписки в черновик');
  const putDoc = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  // Выписка без обременений — «не зарегистрированы»; скрытый правообладатель — не подставляется.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПравообладатель (правообладатели): 1.1. Физическое лицо\nВид, номер и дата государственной регистрации права: 2.1. Собственность, № 77:01:0001001:4321-77/051/2020-3\nОграничение прав и обременение объекта недвижимости: не зарегистрировано', 'Выписка ЕГРН скрытая.txt')).status, 201);
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.deepEqual(d.inputs.egrn.rights, {
    holders: null,
    kind: { v: 'Собственность', name: 'Выписка ЕГРН скрытая.txt', page: 1 },
    enc: { v: 'не зарегистрированы', name: 'Выписка ЕГРН скрытая.txt', page: 1 },
  });
  assert.doesNotMatch(d.body, /\| Правообладатель \|/);
  assert.match(d.body, /\| Вид права \| Собственность \(по выписке ЕГРН\) \|/);
  assert.match(d.body, /\| Ограничения и обременения \| не зарегистрированы \(по выписке ЕГРН\) \|/);
  // Полная выписка: два правообладателя, долевая собственность, ипотека и аренда — каждое в своей строке таблицы.
  await S.sql`update documents set deleted_at = now() where order_id = ${o.id} and filename = 'Выписка ЕГРН скрытая.txt'`;
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПравообладатель (правообладатели): 1.1. Сергеев Сергей Сергеевич\n1.2. Сергеева Анна Петровна\nВид, номер и дата государственной регистрации права: 2.1. Общая долевая собственность, 1/2\nОграничение прав и обременение объекта недвижимости:\nвид: Ипотека в силу закона\nвид: Аренда (в том числе субаренда)', 'Выписка ЕГРН.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.egrn.rights, {
    holders: { v: 'Сергеев Сергей Сергеевич, Сергеева Анна Петровна', name: 'Выписка ЕГРН.txt', page: 1 },
    kind: { v: 'Общая долевая собственность', name: 'Выписка ЕГРН.txt', page: 1 },
    enc: { v: 'Ипотека в силу закона; Аренда (в том числе субаренда)', name: 'Выписка ЕГРН.txt', page: 1 },
  });
  assert.match(d.body, /\| Правообладатель \| Сергеев Сергей Сергеевич, Сергеева Анна Петровна \(по выписке ЕГРН\) \|/);
  assert.match(d.body, /\| Вид права \| Общая долевая собственность \(по выписке ЕГРН\) \|/);
  assert.match(d.body, /\| Ограничения и обременения \| Ипотека в силу закона; Аренда \(в том числе субаренда\) \(по выписке ЕГРН\) \|/);
  assert.match(lastPrompt(), /Правообладатель по выписке ЕГРН: Сергеев Сергей Сергеевич, Сергеева Анна Петровна \(выписка «Выписка ЕГРН\.txt», стр\. 1\)/);
  assert.match(lastPrompt(), /Вид права по выписке ЕГРН: Общая долевая собственность/);
  assert.match(lastPrompt(), /Ограничения и обременения по выписке ЕГРН: Ипотека в силу закона; Аренда/);
  // Модель оставила пометки — программа ставит значения из выписки; другие пометки не трогает.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nСобственник: [заполнить: собственник]. Вид права: [заполнить: вид права]. Обременения: [заполнить: обременения]. Стоимость — [заполнить: расчёт]\n## 2. Задание на оценку\nТекст', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  } finally { S.providers.ai.complete = orig; }
  assert.match(d.body, /Собственник: Сергеев Сергей Сергеевич, Сергеева Анна Петровна\. Вид права: Общая долевая собственность\. Обременения: Ипотека в силу закона; Аренда \(в том числе субаренда\)\. Стоимость — \[заполнить: расчёт\]/);
  // Правка эксперта сохраняет, откуда значения.
  const saved = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: `${d.body}\nправка`, from: d.id })).body.draft;
  assert.equal(saved.inputs.egrn.rights.kind.v, 'Общая долевая собственность');
  // Вторая выписка на объект с другим видом права — вид права не подставляется, эксперт видит оба.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПравообладатель (правообладатели): 1.1. Сергеев Сергей Сергеевич\nВид, номер и дата государственной регистрации права: 2.1. Собственность', 'Выписка ЕГРН новая.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: saved.id })).body.draft;
  assert.equal(d.inputs.egrn.rights.kind.values.length, 2);
  assert.doesNotMatch(d.body, /\| Вид права \|/);
  assert.doesNotMatch(lastPrompt(), /Вид права по выписке ЕГРН/);
});

test('2.254: размер доли из выписки ЕГРН — в таблицу задания, модели и вместо пометок; у собственников разные доли — та, что в заявке, иначе эксперт выбирает сам', async () => {
  const o = await inWork('Квартира: доля из выписки в черновик');
  const putDoc = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  await S.sql`update orders set fields = fields || ${JSON.stringify({ share_size: '1/3' })}::jsonb where id = ${o.id}`;
  // Одна доля в выписке — она в строке «Размер доли», в заявке другая — рядом; номер регистрации «-77/051/» не доля.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nПравообладатель (правообладатели): 1.1. Сергеев Сергей Сергеевич\nВид, номер и дата государственной регистрации права: 2.1. Общая долевая собственность, доля в праве 1/2, № 77:01:0001001:4321-77/051/2020-3', 'Выписка ЕГРН.txt')).status, 201);
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.deepEqual(d.inputs.egrn.share_size, { v: '1/2', name: 'Выписка ЕГРН.txt', page: 1, typed: '1/3' });
  assert.match(d.body, /\| Размер доли \(если оценивается доля\) \| 1\/2 \(по выписке ЕГРН; в заявке — 1\/3\) \|/);
  assert.match(lastPrompt(), /Размер оцениваемой доли по выписке ЕГРН: 1\/2 \(выписка «Выписка ЕГРН\.txt», стр\. 1\)/);
  // Модель оставила пометки — программа ставит долю; «доля рынка» — не про объект.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nОценивается доля [заполнить: размер доли] (доля в праве — [заполнить: доля в праве]). Доля рынка — [заполнить: доля рынка]\n## 2. Задание на оценку\nТекст', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  } finally { S.providers.ai.complete = orig; }
  assert.match(d.body, /Оценивается доля 1\/2 \(доля в праве — 1\/2\)\. Доля рынка — \[заполнить: доля рынка\]/);
  // В заявке та же доля другой записью (2/4) — без «в заявке — …».
  await S.sql`update orders set fields = fields || ${JSON.stringify({ share_size: '2/4' })}::jsonb where id = ${o.id}`;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.egrn.share_size.typed, null);
  // У собственников разные доли: в заявке одна из них — она, остальные видны; нет в заявке — эксперт выбирает сам.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\n1.2. Сергеева Анна Петровна (доля 1/4)', 'Выписка ЕГРН вторая.txt')).status, 201);
  await S.sql`update orders set fields = fields || ${JSON.stringify({ share_size: '1/4' })}::jsonb where id = ${o.id}`;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.egrn.share_size, { v: '1/4', name: 'Выписка ЕГРН вторая.txt', page: 1, typed: null, others: ['1/2'] });
  assert.match(d.body, /\| Размер доли \(если оценивается доля\) \| 1\/4 \(по выписке ЕГРН\) \|/);
  await S.sql`update orders set fields = fields - 'share_size' where id = ${o.id}`;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.egrn.share_size, { values: ['1/4', '1/2'] });
  assert.doesNotMatch(d.body, /\| Размер доли/);
  assert.doesNotMatch(lastPrompt(), /Размер оцениваемой доли по выписке ЕГРН/);
});

test('2.261: назначение помещения из выписки ЕГРН — в таблицу задания, модели и вместо пометок; в выписках разные — эксперт выбирает сам', async () => {
  const o = await inWork('Квартира: назначение из выписки в черновик');
  const putDoc = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  await S.sql`update orders set fields = fields || ${JSON.stringify({ object_type: 'flat' })}::jsonb where id = ${o.id}`;
  // В выписке нежилое, в заявке квартира (жилое) — назначение из выписки, заявка рядом; «многоквартирный дом» — про здание.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nНазначение: Нежилое\nНаименование: помещение\nНазначение здания: многоквартирный дом', 'Выписка ЕГРН.txt')).status, 201);
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.deepEqual(d.inputs.egrn.use, { v: 'нежилое', of: 'помещения', name: 'Выписка ЕГРН.txt', page: 1, typed: 'жилое' });
  assert.match(d.body, /\| Назначение помещения \| нежилое \(по выписке ЕГРН; в заявке — жилое\) \|/);
  assert.match(lastPrompt(), /Назначение помещения по выписке ЕГРН: нежилое \(выписка «Выписка ЕГРН\.txt», стр\. 1\)/);
  // Модель оставила пометки — программа ставит назначение; назначение участка и аналога — не трогает.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nНазначение помещения: [заполнить: назначение помещения]; объект — [заполнить: назначение]. Участок — [заполнить: назначение участка], аналог — [заполнить: назначение аналога]\n## 2. Задание на оценку\nТекст', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  } finally { S.providers.ai.complete = orig; }
  assert.match(d.body, /Назначение помещения: нежилое; объект — нежилое\. Участок — \[заполнить: назначение участка\], аналог — \[заполнить: назначение аналога\]/);
  // В заявке нежилое помещение — без «в заявке — …».
  await S.sql`update orders set fields = fields || ${JSON.stringify({ object_type: 'commercial' })}::jsonb where id = ${o.id}`;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.egrn.use.typed, null);
  assert.match(d.body, /\| Назначение помещения \| нежилое \(по выписке ЕГРН\) \|/);
  // Вторая выписка на объект с жилым назначением — не подставляется, эксперт видит оба.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nНазначение помещения: жилое', 'Выписка ЕГРН вторая.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.egrn.use, { of: 'помещения', values: ['жилое', 'нежилое'] });
  assert.doesNotMatch(d.body, /\| Назначение помещения/);
  assert.doesNotMatch(lastPrompt(), /Назначение помещения по выписке ЕГРН/);
});

test('2.222: этаж, этажность и адрес из выписки ЕГРН — в таблицу задания, модели и вместо пометок; разные — эксперт выбирает сам', async () => {
  const o = await inWork('Квартира: этаж и адрес из выписки в черновик');
  const putDoc = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  await S.sql`update orders set fields = fields || ${JSON.stringify({ floor: '5 / 9' })}::jsonb where id = ${o.id}`;
  // Выписка на помещение: этаж и адрес; на здание — этажность и тот же адрес короче (не спорят).
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nАдрес (местоположение): г. Москва, ул. Долевая, д. 3, кв. 8\nНомер, тип этажа, на котором расположено помещение: Этаж № 6', 'Выписка ЕГРН квартира.txt')).status, 201);
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Здание\nКадастровый номер: 77:01:0001001:100\nМестоположение: г. Москва, ул. Долевая, д. 3\nКоличество этажей, в том числе подземных этажей: 10, в том числе подземных 1', 'Выписка ЕГРН дом.txt')).status, 201);
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.deepEqual(d.inputs.egrn.floor, { v: '6 / 10, надземных 9', floor: 6, floors: 10, above: 9, name: 'Выписка ЕГРН квартира.txt', page: 1, typed: '5 / 9' });
  assert.deepEqual(d.inputs.egrn.address, { v: 'г. Москва, ул. Долевая, д. 3, кв. 8', name: 'Выписка ЕГРН квартира.txt', page: 1, typed: 'г. Москва, тестовая ул., 9' });
  assert.match(d.body, /\| Адрес объекта \| г\. Москва, ул\. Долевая, д\. 3, кв\. 8 \(по выписке ЕГРН; в заявке — г\. Москва, тестовая ул\., 9\) \|/);
  assert.match(d.body, /\| Этаж \/ этажей в доме \| 6 \/ 10, надземных 9 \(по выписке ЕГРН; в заявке — 5 \/ 9\) \|/);
  assert.match(lastPrompt(), /Этаж объекта по выписке ЕГРН: 6, этажей в доме: 10, из них надземных 9/);
  assert.match(lastPrompt(), /Адрес объекта по выписке ЕГРН: г\. Москва, ул\. Долевая, д\. 3, кв\. 8/);
  // Модель оставила пометки — программа ставит этаж, этажность и адрес; адрес аналога не трогает.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nКвартира по адресу [заполнить: адрес объекта] на [заполнить: этаж] этаже [заполнить: этажность дома]-этажного дома (этаж/этажность — [заполнить: этаж / этажность]). Адрес аналога — [заполнить: адрес аналога]\n## 2. Задание на оценку\nТекст', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  } finally { S.providers.ai.complete = orig; }
  assert.match(d.body, /Квартира по адресу г\. Москва, ул\. Долевая, д\. 3, кв\. 8 на 6 этаже 10 \(надземных 9\)-этажного дома \(этаж\/этажность — 6 \/ 10 \(надземных 9\)\)\. Адрес аналога — \[заполнить: адрес аналога\]/);
  // В заявке то же, что в выписке, — без «в заявке — …» (9 надземных — тоже верно).
  await S.sql`update orders set fields = fields || ${JSON.stringify({ floor: '6 / 9', address: 'Москва, Долевая улица, дом 3, квартира 8' })}::jsonb where id = ${o.id}`;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.egrn.floor.typed, null);
  assert.equal(d.inputs.egrn.address.typed, null);
  // Вторая выписка на помещение с другим этажом и адресом — не подставляются, эксперт видит оба.
  assert.equal((await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4322\nАдрес (местоположение): г. Москва, ул. Долевая, д. 3, кв. 9\nНомер этажа: 7', 'Выписка ЕГРН другая.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.egrn.floor, { values: ['этаж 7', 'этаж 6'] });
  assert.deepEqual(d.inputs.egrn.address, { values: ['г. Москва, ул. Долевая, д. 3, кв. 9', 'г. Москва, ул. Долевая, д. 3, кв. 8'] });
  assert.match(d.body, /\| Этаж \/ этажей в доме \| 6 \/ 9 \|/);
  assert.doesNotMatch(lastPrompt(), /Этаж объекта по выписке ЕГРН|Адрес объекта по выписке ЕГРН/);
});

test('2.281: адрес объекта из задания на оценку — в таблицу задания, модели и вместо пометки, когда в выписках адреса нет', async () => {
  const o = await inWork('Квартира: адрес из задания в черновик');
  const putDoc = (body, name, kind) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), ...(kind ? { 'x-doc-kind': kind } : {}) } });
  // Без задания — адрес из заявки, как раньше.
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.equal(d.inputs.task_address, null);
  assert.match(d.body, /\| Адрес объекта \| г\. Москва, тестовая ул\., 9 \|/);
  assert.equal((await putDoc('ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nАдрес объекта: г. Москва, ул. Садовая, д. 5, кв. 12\nДата оценки: 03.10.2026', 'Задание на оценку.txt', 'basis')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.deepEqual(d.inputs.task_address, { v: 'г. Москва, ул. Садовая, д. 5, кв. 12', what: 'в задании на оценку', by: 'по заданию на оценку',
    name: 'Задание на оценку.txt', page: 1, typed: 'г. Москва, тестовая ул., 9' });
  assert.match(d.body, /\| Адрес объекта \| г\. Москва, ул\. Садовая, д\. 5, кв\. 12 \(по заданию на оценку; в заявке — г\. Москва, тестовая ул\., 9\) \|/);
  assert.match(lastPrompt(), /Адрес объекта в задании на оценку «Задание на оценку\.txt» \(стр\. 1\): г\. Москва, ул\. Садовая, д\. 5, кв\. 12/);
  // Модель оставила пометку — программа ставит адрес из задания; адрес аналога не трогает.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '## 1. Основные факты и выводы\nКвартира по адресу [заполнить: адрес объекта]. Адрес аналога — [заполнить: адрес аналога]\n## 2. Задание на оценку\nТекст', model: 'fake' });
  try {
    d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  } finally { S.providers.ai.complete = orig; }
  assert.match(d.body, /Квартира по адресу г\. Москва, ул\. Садовая, д\. 5, кв\. 12\. Адрес аналога — \[заполнить: адрес аналога\]/);
  // В заявке тот же адрес — без «в заявке — …».
  await S.sql`update orders set fields = fields || ${JSON.stringify({ address: 'Москва, Садовая улица, дом 5, квартира 12' })}::jsonb where id = ${o.id}`;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.task_address.typed, null);
  // Выписка ЕГРН с адресом — важнее задания: адрес по выписке, задания в таблице нет.
  const egrn = (await putDoc('Выписка из ЕГРН\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nАдрес (местоположение): г. Москва, ул. Садовая, д. 5, кв. 21', 'Выписка ЕГРН квартира.txt')).body.document;
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.task_address, null);
  assert.match(d.body, /\| Адрес объекта \| г\. Москва, ул\. Садовая, д\. 5, кв\. 21 \(по выписке ЕГРН/);
  assert.doesNotMatch(lastPrompt(), /Адрес объекта в задании на оценку/);
  // Выписку удалили, рядом письмо с другим адресом — какой верный, решает эксперт: из заявки, как раньше.
  assert.equal((await owner.req('DELETE', `/api/documents/${egrn.id}`)).status, 204);
  assert.equal((await putDoc('Письмо заказчика\nПросим оценить квартиру по адресу: г. Москва, ул. Садовая, д. 7, кв. 3', 'Письмо.txt')).status, 201);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.task_address, null);
  assert.match(d.body, /\| Адрес объекта \| Москва, Садовая улица, дом 5, квартира 12 \|/);
});

test('2.273: перечень документов черновика — номер и дата выписки ЕГРН из самой выписки; сверка 2.264 по нему без находок', async () => {
  const o = await inWork('Квартира: номер выписки в перечне документов');
  const putDoc = (body, name) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  const egrnText = 'Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n02.10.2026 № КУВИ-001/2026-12345678\nВид объекта недвижимости: Помещение\nПлощадь, м2: 54,3';
  assert.equal((await putDoc(egrnText, 'ЕГРН от 01.09.2026.txt')).status, 201);
  // Выписка без номера — только дата из выписки; документ не выписка — как раньше.
  const noNum = 'Выписка из ЕГРН об объекте недвижимости\nДата выдачи выписки: 05.10.2026\nВид объекта недвижимости: Помещение';
  assert.equal((await putDoc(noNum, 'Выписка ЕГРН без номера.txt')).status, 201);
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.match(d.body, /\d+\. Выписка из ЕГРН № КУВИ-001\/2026-12345678 от 02\.10\.2026 — файл «ЕГРН от 01\.09\.2026\.txt», получен \d\d\.\d\d\.\d{4}/);
  assert.match(d.body, /\d+\. Выписка из ЕГРН от 05\.10\.2026 — файл «Выписка ЕГРН без номера\.txt»/);
  assert.match(d.body, /\d+\. Документ — файл «Сведения\.docx»/);
  // ИИ-проверка (2.264) читает перечень так же: номер и дата сходятся, имя файла в «…» не в счёт.
  const { runAutoChecks } = await import('../../src/ai/report-checks.mjs');
  const egrn = [{ id: 'e1', name: 'ЕГРН от 01.09.2026.txt', pages: [egrnText] }, { id: 'e2', name: 'Выписка ЕГРН без номера.txt', pages: [noNum] }];
  assert.deepEqual(runAutoChecks(['egrn_doc_match'], [{ name: 'Отчёт.docx', pages: [d.body] }], { fields: FIELDS, service: 'realty', egrn }).egrn_doc_match, []);
  // «Обновить перечень» — так же; выписку удалили — строка уходит.
  const [doc] = await S.sql`select id from documents where order_id = ${o.id} and filename = 'ЕГРН от 01.09.2026.txt'`;
  assert.equal((await owner.req('DELETE', `/api/documents/${doc.id}`)).status, 204);
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/sources`, { from: d.id })).body.draft;
  assert.doesNotMatch(d.body, /КУВИ-001\/2026-12345678/);
  assert.match(d.body, /Выписка из ЕГРН от 05\.10\.2026 — файл/);
});
