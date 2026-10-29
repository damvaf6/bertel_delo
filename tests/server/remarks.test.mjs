// Замечания к сданному отчёту (задача 2.431): после «готово» заказчик пишет, что пришли замечания от банка или суда, и
// прикладывает файл замечаний; дело снова у того же эксперта, срок ответа — 3 рабочих дня (описание модуля), без второй выплаты.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { addDays, availableActions, findTransition, todayMsk } from '../../src/orders/workflow.mjs';
import { workdaysAfter } from '../../src/orders/holidays.mjs';
import expertise from '../../src/modules/expertise.mjs';
import translation from '../../src/modules/translation.mjs';

let S, owner, dispatcher, spec, other;
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

async function doneOrder(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  assert.equal((await upload(spec, o, 'results', 'Отчёт.pdf')).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
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
