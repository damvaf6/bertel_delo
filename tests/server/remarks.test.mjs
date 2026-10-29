// Замечания к сданному отчёту (задача 2.431): после «готово» заказчик пишет, что пришли замечания от банка или суда, и
// прикладывает файл замечаний; дело снова у того же эксперта, срок ответа — 3 рабочих дня (описание модуля), без второй выплаты.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults, makeOrg, addMember } from '../helpers.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { addDays, availableActions, findTransition, todayMsk } from '../../src/orders/workflow.mjs';
import { workdaysAfter } from '../../src/orders/holidays.mjs';
import expertise from '../../src/modules/expertise.mjs';
import translation from '../../src/modules/translation.mjs';

let S, owner, dispatcher, spec, other, head;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 31', area: '44' };

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004311');
  dispatcher = await login(S, '+79990004312');
  spec = await login(S, '+79990004313');
  other = await login(S, '+79990004314');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function step(c, o, to, extra = {}) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status, ...extra });
}
const upload = (c, o, path, name, kind) => c.req('POST', `/api/orders/${o.id}/${path}`, Buffer.from(`%PDF ${name}`), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name), ...(kind ? { 'x-doc-kind': kind } : {}) },
});

async function doneOrder(title, ex = spec, head = null) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: ex.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(ex, o, 'in_work')).status, 200);
  assert.equal((await upload(ex, o, 'results', 'Отчёт.pdf')).status, 201);
  await signResults(S, ex, o.id);
  if (head) await signOrg(o, head);
  assert.equal((await step(ex, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  const r = await step(dispatcher, o, 'done');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return o;
}

test('замечания — в описании модуля: у экспертизы 3 рабочих дня, у переводов нет; ошибка в описании — не стартует', () => {
  const reg = createRegistry();
  assert.deepEqual(reg.remarks('expertise'), { reply_days: 3 });
  assert.equal(reg.remarks('translation'), null);
  const { remarks, ...none } = structuredClone(expertise);
  assert.ok(remarks);
  assert.throws(() => createRegistry([{ ...none, remarks: { reply_days: 0 } }]), /reply_days/);
  assert.throws(() => createRegistry([{ ...none, remarks: { reply_days: 3, extra: 1 } }]), /замечания/);
  assert.throws(() => createRegistry([{ ...structuredClone(translation), remarks: { reply_days: 3 } }]), /proofread/);
  // Шаг — только с признаком модуля: у переводов после выдачи — своя переделка.
  assert.equal(findTransition('done', 'in_work', ['customer']), null);
  assert.equal(findTransition('done', 'in_work', ['customer'], ['remarks'])?.name, 'Пришли замечания к отчёту');
  assert.equal(findTransition('done', 'in_work', ['customer'], ['redo'])?.name, 'Нашли ошибку — переделать бесплатно');
  assert.ok(availableActions('done', ['customer'], ['remarks']).some((a) => a.to === 'in_work' && a.remarks && a.reason));
});

test('рабочие дни после: выходные и праздники не в счёт', () => {
  assert.equal(workdaysAfter('2026-10-28', 3), '2026-11-02');
  assert.equal(workdaysAfter('2026-10-30', 3), '2026-11-05', '4 ноября — праздник');
  assert.equal(workdaysAfter('2026-12-30', 1), '2027-01-11', 'новогодние каникулы');
});

test('пришли замечания к отчёту: файл и текст, дело снова у эксперта, срок ответа 3 рабочих дня, без второй выплаты', async () => {
  const o = await doneOrder('Квартира: замечания банка');
  const view = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.ok(view.actions.some((a) => a.to === 'in_work' && a.name === 'Пришли замечания к отчёту' && a.remarks));
  assert.ok(!view.actions.some((a) => a.name === 'Нашли ошибку — переделать бесплатно'), 'у экспертизы — не переделка переводов');
  assert.equal(view.remarks, null);
  // Диспетчер и эксперт такой кнопки не видят — замечания приносит заказчик.
  assert.ok(!(await dispatcher.req('GET', `/api/orders/${o.id}`)).body.actions.some((a) => a.to === 'in_work'));
  assert.ok(!(await spec.req('GET', `/api/orders/${o.id}`)).body.actions.some((a) => a.to === 'in_work'));
  assert.equal((await step(spec, o, 'in_work', { reason: 'x' })).status, 403);

  // Текст обязателен; файл замечаний — документ этого дела.
  assert.equal((await step(owner, o, 'in_work')).body.error, 'reason_required');
  const file = await upload(owner, o, 'documents', 'Замечания банка.pdf');
  assert.equal(file.status, 201, JSON.stringify(file.body));
  const otherOrder = (await other.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Чужое' })).body.order;
  const foreign = await upload(other, otherOrder, 'documents', 'Чужой файл.pdf');
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк просит пояснить аналоги', document_id: foreign.body.document.id })).status, 404);
  const [res] = await S.sql`select id from documents where order_id = ${o.id} and kind = 'result'`;
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк просит пояснить аналоги', document_id: res.id })).status, 404, 'файл результата — не замечания');

  const r = await step(owner, o, 'in_work', { reason: 'Банк просит пояснить выбор аналогов и корректировку на торг', document_id: file.body.document.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const due = workdaysAfter(todayMsk(), 3);
  const [row] = await S.sql`select status, executor_user_id, remarks_due, remarks_round, remarks_doc_id, proofread, deadline from orders where id = ${o.id}`;
  assert.equal(row.status, 'in_work');
  assert.equal(row.executor_user_id, spec.user.id, 'дело у того же эксперта');
  assert.equal(row.remarks_due, due);
  assert.equal(row.remarks_round, 1);
  assert.equal(row.remarks_doc_id, file.body.document.id);
  assert.equal(row.proofread, null, 'не переделка переводов');
  assert.ok(row.deadline >= due, 'срок дела — не раньше срока ответа');

  // Эксперт, заказчик и диспетчер видят замечания: когда, срок ответа, текст и файл.
  for (const c of [spec, owner, dispatcher]) {
    const rm = (await c.req('GET', `/api/orders/${o.id}`)).body.remarks;
    assert.equal(rm.due, due);
    assert.equal(rm.open, true);
    assert.equal(rm.round, 1);
    assert.match(rm.text, /аналогов/);
    assert.equal(rm.document.filename, 'Замечания банка.pdf');
  }
  assert.equal((await other.req('GET', `/api/orders/${o.id}`)).status, 404, 'чужому — нет');
  const notes = await S.sql`select user_id, event from notifications where order_id = ${o.id} and event in ('remarks', 'remarks_staff')`;
  assert.ok(notes.some((n) => n.event === 'remarks' && n.user_id === spec.user.id));
  assert.ok(notes.some((n) => n.event === 'remarks_staff' && n.user_id === dispatcher.user.id));
  assert.ok(!notes.some((n) => n.user_id === owner.user.id), 'тому, кто сделал шаг, — нет');

  // Эксперт исправляет, подписывает и сдаёт; после «готово» замечания закрыты, вторая выплата не появляется.
  assert.equal((await upload(spec, o, 'results', 'Отчёт (исправленный).pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  const after = (await owner.req('GET', `/api/orders/${o.id}`)).body.remarks;
  assert.equal(after.open, false);
  const pays = await S.sql`select count(*)::int as n from payouts where order_id = ${o.id}`;
  assert.equal(pays[0].n, 1, 'ответ на замечания — без второй выплаты');

  // Пришли новые замечания (второй круг) — без файла тоже можно.
  assert.equal((await step(owner, o, 'in_work', { reason: 'Суд просит письменные пояснения' })).status, 200);
  const rm2 = (await spec.req('GET', `/api/orders/${o.id}`)).body.remarks;
  assert.equal(rm2.round, 2);
  assert.equal(rm2.document, null);
  assert.match(rm2.text, /Суд/);
});

test('замечания пунктами (2.432): ИИ делит файл замечаний на пункты, эксперт правит и отмечает каждый', async () => {
  const o = await doneOrder('Квартира: замечания пунктами');
  const items = `/api/orders/${o.id}/remarks/items`;
  assert.deepEqual((await spec.req('GET', items)).body, { available: false }, 'замечаний ещё не было');
  assert.equal((await spec.req('POST', `${items}/parse`, {})).status, 409);

  const letter = 'ПАО Банк. Замечания к отчёту № 12/26\n1. Обоснуйте выбор аналогов:\nаналог 3 — другой район.\n'
    + '2) Корректировка на торг не подтверждена источником.\n3. Приложите выписку ЕГРН не старше 30 дней.\n\nС уважением, отдел залогов';
  const file = await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(letter), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Замечания банка.txt') },
  });
  assert.equal(file.status, 201, JSON.stringify(file.body));
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк прислал три замечания', document_id: file.body.document.id })).status, 200);

  // Делит только исполнитель; заказчик и диспетчер — смотрят.
  for (const c of [owner, dispatcher]) {
    assert.equal((await c.req('POST', `${items}/parse`, {})).status, 403);
    assert.equal((await c.req('PUT', items, { items: [{ text: 'x' }] })).status, 403);
  }
  assert.equal((await other.req('GET', items)).status, 404, 'чужому — нет');
  const parsed = await spec.req('POST', `${items}/parse`, {});
  assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
  assert.deepEqual(parsed.body.items.map((i) => i.text), [
    'Обоснуйте выбор аналогов: аналог 3 — другой район.',
    'Корректировка на торг не подтверждена источником.',
    'Приложите выписку ЕГРН не старше 30 дней. С уважением, отдел залогов',
  ]);
  assert.ok(parsed.body.items.every((i) => i.by_ai && i.resolution === null));
  assert.equal(parsed.body.left, 3);
  assert.equal(parsed.body.can_write, true);
  const call = S.providers.ai.calls.filter((c) => c.args?.purpose === 'remarks').at(-1);
  assert.match(call.args.messages.at(-1).content, /Корректировка на торг/, 'модели — текст файла замечаний');

  // Пункты уже есть — новый разбор только с «Заменить».
  assert.equal((await spec.req('POST', `${items}/parse`, {})).body.error, 'items_exist');

  // Эксперт правит: третий пункт — без подписи письма, отметки, свой пункт.
  const list = parsed.body.items;
  const saved = await spec.req('PUT', items, { items: [
    { ...list[0], resolution: 'fixed', note: 'Аналог 3 заменён, раздел 8.2' },
    { ...list[1], resolution: 'explained', note: 'Скидка на торг — по справочнику Лейфера' },
    { text: 'Приложите выписку ЕГРН не старше 30 дней.', by_ai: true },
    { text: 'Проверить дату оценки на титуле' },
  ] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.items.map((i) => [i.resolution, i.by_ai]), [['fixed', true], ['explained', true], [null, true], [null, false]]);
  assert.equal(saved.body.items[0].note, 'Аналог 3 заменён, раздел 8.2');
  assert.equal(saved.body.left, 2);
  for (const c of [owner, dispatcher]) {
    const v = (await c.req('GET', items)).body;
    assert.equal(v.items.length, 4);
    assert.equal(v.can_write, false);
  }
  // Неверный ввод.
  assert.equal((await spec.req('PUT', items, { items: [{ text: '' }] })).status, 400);
  assert.equal((await spec.req('PUT', items, { items: [{ text: 'a', resolution: 'maybe' }] })).status, 400);
  assert.equal((await spec.req('PUT', items, { items: 'x' })).status, 400);
  assert.equal((await spec.req('PUT', items, { items: Array.from({ length: 51 }, (_, i) => ({ text: `п${i}` })) })).status, 400);

  // Заменить разбором — список снова от ИИ.
  const again = await spec.req('POST', `${items}/parse`, { replace: true });
  assert.equal(again.body.items.length, 3);

  // Сдано — только для чтения; новый круг замечаний — новый список.
  assert.equal((await upload(spec, o, 'results', 'Отчёт (исправленный).pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  const closed = (await spec.req('GET', items)).body;
  assert.equal(closed.can_write, false);
  assert.equal(closed.items.length, 3);
  assert.equal((await spec.req('PUT', items, { items: [] })).body.error, 'status_changed');
  assert.equal((await step(owner, o, 'in_work', { reason: 'Суд просит пояснить:\n1. Почему без осмотра\n2. Какой источник цен' })).status, 200);
  const round2 = await spec.req('GET', items);
  assert.equal(round2.body.round, 2);
  assert.equal(round2.body.items.length, 0);
  const p2 = await spec.req('POST', `${items}/parse`, {});
  assert.deepEqual(p2.body.items.map((i) => i.text), ['Почему без осмотра', 'Какой источник цен'], 'без файла — по тексту заказчика');
});

test('пункты по нумерации: без номеров — абзацы, один абзац — один пункт, повторы и пустые — нет', async () => {
  const { splitRemarks, cleanItems } = await import('../../src/orders/remarks.mjs');
  assert.deepEqual(splitRemarks('Замечания:\n1. Первое\n2. Второе\n- Третье'), ['Первое', 'Второе', 'Третье']);
  assert.deepEqual(splitRemarks('Пункт 1. Аналоги\nПункт 2: Торг'), ['Аналоги', 'Торг']);
  assert.deepEqual(splitRemarks('Первый абзац\n\nВторой абзац'), ['Первый абзац', 'Второй абзац']);
  assert.deepEqual(splitRemarks('Одно замечание без номера'), ['Одно замечание без номера']);
  assert.deepEqual(cleanItems(['a', ' a ', '', 'A', { text: 'b' }, 5]), ['a', 'b']);
  assert.equal(cleanItems(['x'.repeat(2000)])[0].length, 1000);
});

test('ответ на замечания Word (2.433): пункт, что сделано и где в отчёте; приложить к исправленному отчёту', async () => {
  const { extractPages } = await import('../../src/ai/extract.mjs');
  await spec.req('PATCH', '/api/me', { full_name: 'Ответов Эксперт' });
  const o = await doneOrder('Квартира: ответ на замечания');
  const base = `/api/orders/${o.id}/remarks`;
  const word = async (c) => {
    const r = await fetch(`${S.base}${base}/answer`, { headers: { cookie: c.cookie } });
    if (r.status !== 200) return { status: r.status, body: await r.json() };
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: 200, name: decodeURIComponent(r.headers.get('content-disposition').split("''")[1]),
      text: (await extractPages(buf, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n') };
  };
  assert.equal((await word(spec)).body.error, 'no_remarks');
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк:\n1. Обоснуйте аналоги\n2. Скидка на торг без источника' })).status, 200);
  assert.equal((await word(spec)).body.error, 'no_items');
  assert.equal((await spec.req('POST', `${base}/items/parse`, {})).status, 200);
  assert.equal((await word(spec)).body.error, 'items_unmarked', 'без отметок — нельзя');
  assert.equal((await spec.req('POST', `${base}/answer`, {})).body.error, 'items_unmarked');

  // Место в отчёте — по желанию, не длиннее 200 знаков.
  assert.equal((await spec.req('PUT', `${base}/items`, { items: [{ text: 'a', place: 'x'.repeat(201) }] })).status, 400);
  const saved = await spec.req('PUT', `${base}/items`, { items: [
    { text: 'Обоснуйте аналоги', resolution: 'fixed', note: 'Аналог 3 заменён на аналог из того же района', place: 'раздел 8.2, стр. 31' },
    { text: 'Скидка на торг без источника', resolution: 'explained', note: 'Скидка — по справочнику Лейфера, 2026' },
  ] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.items.map((i) => i.place), ['раздел 8.2, стр. 31', '']);
  assert.equal(saved.body.answer, null);

  // Скачать — все стороны дела; чужому — нет.
  for (const c of [spec, owner, dispatcher]) {
    const w = await word(c);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.match(w.name, /^Ответ на замечания [0-9A-F]{8}\.docx$/);
    for (const s of ['Ответ на замечания к отчёту', 'Обоснуйте аналоги', 'Исправлено в отчёте. Аналог 3 заменён', 'раздел 8.2, стр. 31',
      'Пояснение без правки. Скидка — по справочнику Лейфера', 'исправлено в отчёте — 1, пояснений без правки — 1',
      'Исправленный отчёт прилагается.', 'Ответов Эксперт']) assert.ok(w.text.includes(s), `${s}\n${w.text}`);
  }
  assert.equal((await word(other)).status, 404);

  // Приложить — только исполнитель; файлом результата.
  for (const c of [owner, dispatcher]) assert.equal((await c.req('POST', `${base}/answer`, {})).status, 403);
  const att = await spec.req('POST', `${base}/answer`, {});
  assert.equal(att.status, 201, JSON.stringify(att.body));
  assert.equal(att.body.document.kind, 'result');
  assert.equal(att.body.answer.id, att.body.document.id);
  assert.equal((await spec.req('POST', `${base}/answer`, {})).body.error, 'answer_exists', 'второй раз — только «Заменить»');
  const again = await spec.req('POST', `${base}/answer`, { replace: true });
  assert.equal(again.status, 201);
  const results = await S.sql`select id, deleted_at from documents where order_id = ${o.id} and filename like 'Ответ на замечания%'`;
  assert.equal(results.length, 2);
  assert.deepEqual(results.filter((d) => !d.deleted_at).map((d) => d.id), [again.body.document.id], 'прежний ответ убран из дела');
  assert.equal((await owner.req('GET', `${base}/items`)).body.answer.filename, again.body.document.filename);
  const audits = await S.sql`select action from audit_log where subject_id = ${String(o.id)} and action like 'remarks.answer%' order by id`;
  assert.ok(audits.some((a) => a.action === 'remarks.answer.attach'));

  // Сдал на проверку — приложить уже нельзя, скачать можно; новый круг замечаний — ответ ещё не приложен.
  assert.equal((await upload(spec, o, 'results', 'Отчёт (исправленный).pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.equal((await spec.req('POST', `${base}/answer`, { replace: true })).body.error, 'status_changed');
  assert.equal((await word(spec)).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  assert.equal((await step(owner, o, 'in_work', { reason: 'Суд: почему без осмотра' })).status, 200);
  const r2 = (await spec.req('GET', `${base}/items`)).body;
  assert.equal(r2.answer, null);
  await spec.req('PUT', `${base}/items`, { items: [{ text: 'Почему без осмотра', resolution: 'explained', note: 'Объект снесён' }] });
  const w2 = await word(spec);
  assert.match(w2.name, /\(2\)\.docx$/);
  assert.ok(w2.text.includes('Отчёт не изменялся'), w2.text);
  assert.ok(w2.text.includes('2-й раз'), w2.text);
});

test('новая редакция отчёта (2.434): тот же номер, «Редакция от …» на титуле и в колонтитуле; прежняя редакция остаётся в деле', async () => {
  const { extractPages } = await import('../../src/ai/extract.mjs');
  const { unzip } = await import('../../src/docs/docx.mjs');
  const o = await doneOrder('Квартира: новая редакция');
  const day = todayMsk().split('-').reverse().join('.');
  const docx = async () => {
    const r = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    return { text: (await extractPages(buf, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n'),
      footer: unzip(buf).find((f) => f.name === 'word/footer1.xml').data.toString('utf8') };
  };
  const draft = async () => (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.report_number;

  // Замечаний не было — обычный отчёт, без редакции.
  const [first] = await S.sql`select id from documents where order_id = ${o.id} and kind = 'result'`;
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents.find((d) => d.id === first.id).prior_edition, undefined);

  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк: уточните площадь' })).status, 200);
  // Первая редакция сдана «вчера» — дата составления новой редакции остаётся её днём.
  await S.sql`update documents set created_at = created_at - interval '1 day' where id = ${first.id}`;
  await S.sql`update orders set remarks_at = now() where id = ${o.id}`;
  const firstDay = addDays(todayMsk(), -1).split('-').reverse().join('.');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).status, 201);
  const n = await draft();
  assert.deepEqual(n.edition, { date: firstDay, edition: `Редакция от ${day}` });
  const w = await docx();
  const number = (await S.sql`select report_number from orders where id = ${o.id}`)[0].report_number;
  const { orderRef } = await import('../../src/notify/registry.mjs');
  const ref = number ? `№ ${number}` : orderRef(o.id);
  assert.ok(w.text.includes(`Дата составления: ${firstDay}`), w.text.slice(0, 600));
  assert.ok(w.text.includes(`Редакция от ${day}`), w.text.slice(0, 600));
  assert.ok(w.footer.includes(`${ref} · редакция от ${day} · стр. `), w.footer);

  // Прежняя редакция — пометка у файла, удалить нельзя; новая — рядом, её можно убрать, пока дело в работе.
  const list = (await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.equal(list.find((d) => d.id === first.id).prior_edition, todayMsk());
  const del = await spec.req('DELETE', `/api/documents/${first.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.body.error, 'edition_locked');
  const up = await upload(spec, o, 'results', 'Отчёт (редакция 2).pdf');
  assert.equal(up.status, 201);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents.find((d) => d.id === up.body.document.id).prior_edition, undefined);
  assert.equal((await spec.req('DELETE', `/api/documents/${up.body.document.id}`)).status, 204);
});

test('проверка исправленного отчёта по пунктам (2.435): раздел из «Где в отчёте» по номеру и словам, без места — по тексту пункта', async () => {
  const { remarkChecks, placeSection } = await import('../../src/orders/remarks.mjs');
  const before = '## 1. Задание на оценку\nОбъект — квартира\n## 8. Расчёт стоимости\n### 8.2 Сравнительный подход\nАналог 3 — ул. Дальняя\nСкидка на торг 5%\n## 9. Описание объекта\nПлощадь 44 кв. м';
  const after = '## 1. Задание на оценку\nОбъект — квартира\n## 8. Расчёт стоимости\n### 8.2 Сравнительный подход\nАналог 3 — тестовая ул., тот же район\nСкидка на торг 5%\n## 9. Описание объекта\nПлощадь 44 кв. м';
  const list = (titles) => titles.map((title) => ({ title, lines: [] }));
  assert.equal(placeSection('раздел 8.2, стр. 31', list(['1. Задание', '8. Расчёт', '8.2 Сравнительный подход'])).title, '8.2 Сравнительный подход');
  assert.equal(placeSection('п. 8.4, стр. 9', list(['1. Задание', '8. Расчёт'])).title, '8. Расчёт', 'нет 8.4 — раздел 8');
  assert.equal(placeSection('Описание объекта, с. 7', list(['8. Расчёт', '9. Описание объекта'])).title, '9. Описание объекта');
  assert.equal(placeSection('стр. 12', list(['1. Задание', '12. Итог'])), null, 'страница — не номер раздела');

  const r = remarkChecks([
    { text: 'Обоснуйте выбор аналогов', resolution: 'fixed', place: 'раздел 8.2, стр. 31' },
    { text: 'Уточните площадь объекта', resolution: 'fixed', place: 'Описание объекта' },
    { text: 'Аналог 3 из другого района', resolution: 'fixed', place: '' },
    { text: 'Нет ссылки на справочник', resolution: 'fixed', place: '' },
    { text: 'Скидка на торг без источника', resolution: 'explained', place: '' },
    { text: 'Ещё пункт', resolution: null, place: '' },
  ], before, after);
  assert.equal(r.changed, true);
  assert.deepEqual(r.items, [
    { state: 'changed', section: '8.2 Сравнительный подход', added: 1, removed: 1, by: 'place' },
    { state: 'same', section: '9. Описание объекта' },
    { state: 'changed', section: '8.2 Сравнительный подход', added: 1, removed: 1, by: 'text' },
    { state: 'not_found' },
    { state: 'explained' },
    { state: 'unmarked' },
  ]);
  assert.equal(remarkChecks([{ text: 'x', resolution: 'fixed', place: '' }], before, before).changed, false);

  // В деле: проверка — исполнителю и диспетчеру, заказчику — нет; сравнение — с черновиком на момент замечаний.
  const o = await doneOrder('Квартира: проверка по пунктам');
  const base = `/api/orders/${o.id}/remarks/items`;
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк:\n1. Обоснуйте выбор аналогов\n2. Уточните площадь' })).status, 200);
  const items = [
    { text: 'Обоснуйте выбор аналогов', resolution: 'fixed', place: 'раздел 8.2' },
    { text: 'Уточните площадь', resolution: 'fixed', place: 'раздел 9' },
  ];
  let v = (await spec.req('PUT', base, { items })).body;
  assert.deepEqual(v.check, { available: false, changed: false, base_at: null }, 'черновика до замечаний нет');
  assert.equal(v.items[0].check, undefined);
  await S.sql`insert into result_drafts (order_id, author_id, source, body, at)
              values (${o.id}, ${spec.user.id}, 'edit', ${before}, now() - interval '2 days')`;
  v = (await spec.req('GET', base)).body;
  assert.equal(v.check.available, true);
  assert.equal(v.check.changed, false);
  assert.deepEqual(v.items.map((i) => i.check.state), ['same', 'same']);
  const [cur] = await S.sql`select id from result_drafts where order_id = ${o.id} order by id desc limit 1`;
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: after, from: String(cur.id) })).status, 200);
  v = (await spec.req('GET', base)).body;
  assert.equal(v.check.changed, true);
  assert.deepEqual(v.items.map((i) => i.check), [
    { state: 'changed', section: '8.2 Сравнительный подход', added: 1, removed: 1, by: 'place' },
    { state: 'same', section: '9. Описание объекта' },
  ]);
  const d = (await dispatcher.req('GET', base)).body;
  assert.equal(d.items[0].check.state, 'changed', 'диспетчер видит проверку');
  const c = (await owner.req('GET', base)).body;
  assert.equal(c.check, undefined, 'заказчик черновика не видит — и проверки тоже');
  assert.equal(c.items[0].check, undefined);
  assert.equal((await other.req('GET', base)).status, 404);
});

// Подписи организации на всех файлах результата эксперта, подписанных им (2.436).
async function signOrg(o, hd = head) {
  const docs = await S.sql`select d.id from documents d join document_signatures e on e.document_id = d.id and e.role = 'expert'
                           left join document_signatures g on g.document_id = d.id and g.role = 'org'
                           where d.order_id = ${o.id} and d.kind = 'result' and d.deleted_at is null and g.id is null`;
  for (const d of docs) assert.equal((await hd.req('POST', `/api/org-documents/${d.id}/sign`, { confirm: true })).status, 201);
}

test('руководитель (2.436): отбор «Замечания к сданному отчёту» со сроком ответа и пунктами; подпись организации новой редакции', async () => {
  const org = await makeOrg(S.sql, 'ООО «Тестовая оценка 2.436»');
  head = await login(S, '+79990004315');
  await addMember(S.sql, org.id, head.user.id, 'head');
  assert.equal((await head.req('PATCH', '/api/me', { full_name: 'Руководитель Тестовой Оценки' })).status, 200);
  const ex = await login(S, '+79990004316');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, org.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт 2.436' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const o = await doneOrder('Квартира: замечания у руководителя', ex, head);
  const caseOf = async () => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.equal((await caseOf()).remarks, null, 'замечаний не было');

  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк:\n1. Обоснуйте аналоги\n2. Уточните площадь' })).status, 200);
  const due = workdaysAfter(todayMsk(), 3);
  let c = await caseOf();
  assert.equal(c.remarks.due, due);
  assert.equal(c.remarks.round, 1);
  assert.deepEqual([c.remarks.items, c.remarks.left, c.remarks.answer, c.remarks.overdue, c.remarks.hot], [0, 0, false, false, false]);
  assert.equal(c.remarks.text, undefined, 'текст замечаний руководителю не нужен');
  const base = `/api/orders/${o.id}/remarks/items`;
  assert.equal((await ex.req('PUT', base, { items: [{ text: 'Обоснуйте аналоги', resolution: 'fixed', place: 'раздел 8' }, { text: 'Уточните площадь' }] })).status, 200);
  c = await caseOf();
  assert.deepEqual([c.remarks.items, c.remarks.left], [2, 1]);
  // Срок ответа прошёл — красным (hot) и «срок прошёл».
  await S.sql`update orders set remarks_due = ${addDays(todayMsk(), -1)} where id = ${o.id}`;
  c = await caseOf();
  assert.equal(c.remarks.overdue, true);
  assert.equal(c.remarks.hot, true);

  // Подпись организации: прежняя редакция — с пометкой, новая — ждёт подписи с «Новая редакция отчёта … после замечаний».
  const [first] = await S.sql`select id from documents where order_id = ${o.id} and kind = 'result'`;
  await S.sql`update documents set created_at = created_at - interval '1 day' where id = ${first.id}`;
  await S.sql`update orders set remarks_at = now() where id = ${o.id}`;
  const fresh = (await upload(ex, o, 'results', 'Отчёт (редакция 2).pdf')).body.document;
  await signResults(S, ex, o.id);
  const it = (await head.req('GET', `/api/orgs/${org.id}/signing`)).body.items.find((x) => x.documents.some((d) => d.id === fresh.id));
  assert.equal(it.edition.round, 1);
  assert.ok(it.edition.remarks_at);
  assert.equal(it.documents.find((d) => d.id === first.id).prior_edition, todayMsk());
  const nd = it.documents.find((d) => d.id === fresh.id);
  assert.equal(nd.prior_edition, undefined);
  assert.ok(nd.signatures.expert && !nd.signatures.org, 'новая редакция ждёт подписи организации');
  assert.equal((await head.req('POST', `/api/org-documents/${fresh.id}/sign`, { confirm: true })).status, 201);
  // Чужой руководитель дела не видит.
  const org2 = await makeOrg(S.sql, 'ООО «Чужая оценка 2.436»');
  await addMember(S.sql, org2.id, other.user.id, 'head');
  assert.ok(!(await other.req('GET', `/api/orgs/${org2.id}/cases`)).body.cases.some((x) => x.id === o.id));
  assert.equal((await other.req('GET', `/api/orgs/${org.id}/cases`)).status, 404);
  // Дело снова сдано — отбора нет.
  assert.equal((await step(ex, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const k of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${k.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  assert.equal((await caseOf()).remarks, null);
});

test('сводка за месяц (2.437): замечания после сдачи по пользователям отчёта (суд, Сбербанк) и частые пункты', async () => {
  const org = await makeOrg(S.sql, 'ООО «Тестовая оценка 2.437»');
  const h = await login(S, '+79990004317');
  await addMember(S.sql, org.id, h.user.id, 'head');
  assert.equal((await h.req('PATCH', '/api/me', { full_name: 'Руководитель Оценки 2.437' })).status, 200);
  const ex = await login(S, '+79990004318');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, org.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт 2.437' })).status, 200);
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const month = todayMsk().slice(0, 7);
  const report = async () => (await h.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual([r.total.remarks_after, r.total.remarks_after_cases, r.after_by_user, r.after_remarks], [0, 0, [], []], 'замечаний не было');

  // Суд — два круга замечаний по одному делу; Сбербанк — одно дело.
  const court = await doneOrder('Квартира: замечания суда', ex, h);
  const sber = await doneOrder('Квартира: замечания Сбербанка', ex, h);
  await S.sql`update orders set fields = fields || '{"purpose":"bank","bank":"sber"}'::jsonb where id = ${sber.id}`;
  const items = (o, list) => ex.req('PUT', `/api/orders/${o.id}/remarks/items`, { items: list.map((text) => ({ text })) });
  assert.equal((await step(owner, court, 'in_work', { reason: 'Суд: пояснить аналоги' })).status, 200);
  assert.equal((await items(court, ['Обоснуйте выбор аналогов', 'Уточните площадь'])).status, 200);
  assert.equal((await step(owner, sber, 'in_work', { reason: 'Сбербанк: замечания' })).status, 200);
  assert.equal((await items(sber, ['Обоснуйте выбор аналогов.', 'Приложите свежую выписку ЕГРН'])).status, 200);
  // Второй круг суда: дело снова сдано и снова замечания (пункты нового круга).
  assert.equal((await upload(ex, court, 'results', 'Отчёт (редакция 2).pdf')).status, 201);
  await signResults(S, ex, court.id);
  await signOrg(court, h);
  assert.equal((await step(ex, court, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${court.id}/review`)).body;
  for (const k of rv.checks) await dispatcher.req('PUT', `/api/orders/${court.id}/review/${k.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, court, 'done')).status, 200);
  assert.equal((await step(owner, court, 'in_work', { reason: 'Суд: ещё вопрос' })).status, 200);
  assert.equal((await items(court, ['Обоснуйте выбор аналогов'])).status, 200);

  r = await report();
  assert.deepEqual([r.total.remarks_after, r.total.remarks_after_cases, r.total.remarks_after_items], [3, 2, 5]);
  assert.deepEqual(r.after_by_user.map((g) => [g.id, g.name, g.n, g.cases, g.items]),
    [['court', 'Суд', 2, 1, 3], ['sber', 'Сбербанк', 1, 1, 2]], 'пункты обоих кругов суда');
  assert.deepEqual(r.after_remarks[0], { text: 'Обоснуйте выбор аналогов', n: 3, experts: 1 }, 'один и тот же пункт — вместе (точка в конце не в счёт), текст — последний');
  const row = r.experts.find((x) => x.user_id === ex.user.id);
  assert.deepEqual([row.remarks_after, row.remarks_after_cases, row.remarks_after_items], [3, 2, 5]);
  assert.equal(row.after_remarks[0].n, 3);
  // Таблица для Excel — тот же блок.
  const text = (await h.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Замечания после сдачи;Сколько раз пришли/);
  assert.match(text, /Суд;2;1;3;Обоснуйте выбор аналогов ×2/);
  assert.match(text, /Частые замечания банка и суда/);
  // Чужой руководитель сводку не получает, в его сводке этих замечаний нет.
  const org2 = await makeOrg(S.sql, 'ООО «Чужая оценка 2.437»');
  await addMember(S.sql, org2.id, other.user.id, 'head');
  assert.equal((await other.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 404);
  assert.equal((await other.req('GET', `/api/orgs/${org2.id}/report?month=${month}`)).body.report.total.remarks_after, 0);
});

test('архив и перечень для СРО (2.438): новая редакция вместо прежней, в описи обе редакции и их контрольные суммы', async () => {
  const { editionDocs } = await import('../../src/orgs/registry.mjs');
  const { extractPages } = await import('../../src/ai/extract.mjs');
  const { unzip } = await import('../../src/docs/docx.mjs');
  // Перечень: факты — из файлов после последних замечаний; новой редакции нет — прежние файлы, без edition.
  const t0 = '2026-10-20T09:00:00Z';
  const docs = [{ id: 'a', created_at: '2026-10-19T09:00:00Z' }, { id: 'b', created_at: '2026-10-21T09:00:00Z' }];
  assert.deepEqual(editionDocs({ remarks_at: null }, docs), { docs });
  assert.deepEqual(editionDocs({ remarks_at: t0 }, docs.slice(0, 1)), { docs: docs.slice(0, 1) });
  assert.deepEqual(editionDocs({ remarks_at: t0 }, docs), { docs: [docs[1]], edition: { on: '2026-10-21', remarks_on: '2026-10-20', prior: 1 } });

  const o = await doneOrder('Квартира: архив двух редакций');
  const [first] = await S.sql`select id from documents where order_id = ${o.id} and kind = 'result'`;
  assert.equal((await step(owner, o, 'in_work', { reason: 'Суд: поясните корректировку на торг' })).status, 200);
  await S.sql`update documents set created_at = created_at - interval '1 day' where id = ${first.id}`;
  const before = (await spec.req('GET', '/api/specialist/me/registry')).body.registry;
  // Прогон 2.440: ответ готовится — отчёт в перечне по сданной редакции, у строки — «ответ готовится».
  assert.deepEqual(before.rows.find((x) => x.id === o.id)?.edition, { pending: true, remarks_on: todayMsk(), due: workdaysAfter(todayMsk(), 3) },
    'новой редакции ещё нет');
  const up = await upload(spec, o, 'results', 'Отчёт (редакция 2).pdf');
  assert.equal(up.status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);

  const reg = (await spec.req('GET', '/api/specialist/me/registry')).body.registry;
  const row = reg.rows.find((x) => x.id === o.id);
  assert.ok(row, 'дело в перечне');
  assert.deepEqual(row.edition, { on: todayMsk(), remarks_on: todayMsk(), prior: 1 });
  const csv = await fetch(`${S.base}/api/specialist/me/registry?format=csv`, { headers: { cookie: spec.cookie } });
  if (csv.headers.get('content-type')?.includes('csv')) assert.match(await csv.text(), /новая от \d\d\.\d\d\.\d{4} \(после замечаний от/);

  const r = await fetch(`${S.base}/api/specialist/me/registry/archive`, { headers: { cookie: spec.cookie } });
  assert.equal(r.status, 200);
  const files = new Map(unzip(Buffer.from(await r.arrayBuffer())).map((f) => [f.name, f.data]));
  const names = [...files.keys()];
  const dir = names.find((n) => n.endsWith('/Отчёт (редакция 2).pdf'));
  assert.ok(dir, names.join(', '));
  const folder = dir.slice(0, dir.lastIndexOf('/'));
  assert.ok(files.has(`${folder}/Отчёт.pdf`), 'прежняя редакция — тоже в архиве');
  const inv = names.find((n) => n.startsWith('Опись'));
  const text = (await extractPages(files.get(inv), 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  const day = todayMsk().split('-').reverse().join('.');
  assert.ok(text.includes(`прежняя — сдана до замечаний от ${day}`), text.slice(0, 2000));
  assert.ok(text.includes(`новая от ${day}`));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.ok(text.includes(sha(files.get(`${folder}/Отчёт.pdf`))), 'SHA-256 прежней редакции');
  assert.ok(text.includes(sha(files.get(dir))), 'SHA-256 новой редакции');
});

test('«Сегодня» и утренняя сводка эксперта (2.439): замечания к сданному отчёту — ответить сегодня, завтра или срок прошёл', async () => {
  const { expertMorningAlerts } = await import('../../src/ops/today-ops.mjs');
  const { digestText, morningTo } = await import('../../src/notify/morning.mjs');
  const today = todayMsk();
  const mine = async (c = spec) => (await c.req('GET', '/api/today')).body.expert?.remarks ?? [];
  const alerts = async () => (await expertMorningAlerts(S.sql, spec.user.id, today)).remarks;
  const o = await doneOrder('Квартира: ответить на замечания');
  const base = await alerts();
  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк:\n1. Обоснуйте аналоги\n2. Уточните площадь' })).status, 200);
  // Срок ответа — через 3 рабочих дня: ещё не «ответить», строки нет.
  assert.ok(!(await mine()).some((x) => x.id === o.id));
  assert.equal(await alerts(), base);

  // Ответить в следующий рабочий день — строка с пунктами; в «Горит срок» и «нет файла результата» дело не повторяется.
  const next = workdaysAfter(today, 1);
  await S.sql`update orders set remarks_due = ${next}, deadline = ${next} where id = ${o.id}`;
  let x = (await mine()).find((r) => r.id === o.id);
  assert.ok(x, 'строка «Замечания к отчёту — ответить»');
  assert.deepEqual([x.remarks.due, x.remarks.round, x.remarks.items, x.remarks.left, x.remarks.answer, x.remarks.overdue, x.remarks.hot],
    [next, 1, 0, 0, false, false, true]);
  assert.equal(x.remarks.text, undefined, 'текст замечаний — в деле');
  const e = (await spec.req('GET', '/api/today')).body.expert;
  for (const g of ['hot', 'no_result', 'task_due']) assert.ok(!e[g].some((r) => r.id === o.id), g);
  assert.equal(await alerts(), base + 1);

  // Пункты отмечены не все — видно, сколько осталось; срок прошёл — overdue.
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/remarks/items`, { items: [{ text: 'Обоснуйте аналоги', resolution: 'fixed', place: 'раздел 8' }, { text: 'Уточните площадь' }] })).status, 200);
  await S.sql`update orders set remarks_due = ${addDays(today, -1)} where id = ${o.id}`;
  x = (await mine()).find((r) => r.id === o.id);
  assert.deepEqual([x.remarks.items, x.remarks.left, x.remarks.overdue], [2, 1, true]);
  assert.equal(await alerts(), base + 1);

  // Утренняя сводка: своей цифрой первой и к «Сегодня».
  const text = digestText({ remarks: 1 });
  assert.match(text, /^На сегодня: замечания к сданному отчёту — ответить сегодня или завтра: 1 дело/);
  assert.match(digestText({ remarks: 2, due: 1 }), /^На сегодня: замечания[^,]+2 дела, сдать 1 дело/);
  assert.equal(morningTo({ remarks: 1 }), 'today');
  // Чужому эксперту — нет.
  await makeSpecialist(S.sql, other.user.id);
  assert.ok(!(await mine(other)).some((r) => r.id === o.id));

  // Сдал на проверку — строки нет.
  assert.equal((await upload(spec, o, 'results', 'Отчёт (исправленный).pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.ok(!(await mine()).some((r) => r.id === o.id));
  assert.equal(await alerts(), base);
});

test('прогон 2.440: пока эксперт отвечает на замечания, отчёт в перечне для СРО; снова «готово» — не новый отчёт и не новое сданное дело', async () => {
  const { editionDocs } = await import('../../src/orgs/registry.mjs');
  const docs = [{ id: 'a', created_at: '2026-10-19T09:00:00Z' }, { id: 'b', created_at: '2026-10-21T09:00:00Z' }];
  // Ответ готовится — в счёт только сданная редакция, хотя новый файл уже загружен.
  assert.deepEqual(editionDocs({ remarks_at: '2026-10-20T09:00:00Z', remarks_due: '2026-10-23', status: 'in_work' }, docs),
    { docs: [docs[0]], edition: { pending: true, remarks_on: '2026-10-20', due: '2026-10-23' } });

  const ex = await login(S, '+79990004319');
  await makeSpecialist(S.sql, ex.user.id);
  const o = await doneOrder('Квартира: прогон 2.440', ex);
  // Первая сдача — в прошлом квартале (последний день перед кварталом, полдень по Москве).
  const today = todayMsk();
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const qStart = `${today.slice(0, 4)}-${String(q * 3 + 1).padStart(2, '0')}-01`;
  const prevDay = addDays(qStart, -1);
  const prev = { year: Number(prevDay.slice(0, 4)), quarter: Math.floor((Number(prevDay.slice(5, 7)) - 1) / 3) + 1 };
  const now = { year: Number(today.slice(0, 4)), quarter: q + 1 };
  await S.sql`update order_status_history set at = ${`${prevDay}T09:00:00Z`} where order_id = ${o.id} and to_status = 'done'`;
  await S.sql`update documents set created_at = ${`${prevDay}T08:00:00Z`} where order_id = ${o.id}`;
  const reg = async (p) => (await ex.req('GET', `/api/specialist/me/registry?year=${p.year}&quarter=${p.quarter}`)).body.registry.rows.find((x) => x.id === o.id);
  assert.ok(await reg(prev), 'сдан в прошлом квартале');

  assert.equal((await step(owner, o, 'in_work', { reason: 'Банк: обоснуйте аналоги' })).status, 200);
  const answering = await reg(prev);
  assert.ok(answering, 'ответ на замечания готовится — отчёт не пропал из перечня');
  assert.equal(answering.edition.pending, true);
  assert.equal(answering.edition.due, workdaysAfter(today, 3));
  assert.equal(await reg(now), undefined);

  assert.equal((await upload(ex, o, 'results', 'Отчёт (редакция 2).pdf')).status, 201);
  await signResults(S, ex, o.id);
  assert.equal((await step(ex, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  const after = await reg(prev);
  assert.ok(after, 'новая редакция — в перечне того квартала, где отчёт сдан впервые');
  assert.deepEqual(after.edition, { on: today, remarks_on: today, prior: 1 });
  assert.equal(await reg(now), undefined, 'не второй отчёт в этом квартале');

  // «Мои итоги» за этот месяц: снова «готово» после замечаний — не новое сданное дело.
  const rep = (await ex.req('GET', `/api/specialist/me/report?month=${today.slice(0, 7)}`)).body.report;
  assert.equal(rep.cases.some((c) => c.id === o.id), false, JSON.stringify(rep.cases));
  const was = (await ex.req('GET', `/api/specialist/me/report?month=${prevDay.slice(0, 7)}`)).body.report;
  assert.equal(was.cases.some((c) => c.id === o.id), true, 'сдано — в месяце первой сдачи');
});
