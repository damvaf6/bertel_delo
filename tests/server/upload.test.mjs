// Прямая загрузка больших файлов (задача 2.49): облако пропускает через ядро запрос не больше 3,5 МБ, поэтому файл
// больше 3 МБ кладётся прямо в хранилище по подписанной ссылке, а ядро выдаёт ссылку и записывает документ.
// Права — те же, что у обычной загрузки, и проверяются дважды; пропуск чужой заявки или чужого человека не подходит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, other, dispatcher, spec, o;
const MB = 1024 * 1024;

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990005001');
  other = await login(S, '+79990005002');
  dispatcher = await login(S, '+79990005003');
  spec = await login(S, '+79990005004');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Большие файлы' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Большая, 1' } });
});
after(async () => { await S?.close(); });

const put = async (url, buf, type) => (await fetch(new URL(url, S.base), { method: 'PUT', body: buf, headers: { 'content-type': type } })).status;

test('документ на 12 МБ: ссылка → файл в хранилище → документ; размер — по хранилищу; скачивается целиком', async () => {
  const big = Buffer.alloc(12 * MB, 7);
  const r = await owner.req('POST', `/api/orders/${o.id}/documents/upload-url`, { filename: 'Техпаспорт.pdf', mime: 'application/pdf', size: big.length, kind: 'other' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await put(r.body.upload_url, big, r.body.content_type), 200);
  const c = await owner.req('POST', `/api/orders/${o.id}/uploads/complete`, { pass: r.body.pass });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.document.size_bytes, big.length);
  assert.equal(c.body.document.filename, 'Техпаспорт.pdf');
  // Повторное «готово» тем же пропуском — тот же документ, не второй.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/uploads/complete`, { pass: r.body.pass })).body.document.id, c.body.document.id);
  const link = (await owner.req('GET', `/api/documents/${c.body.document.id}/link`)).body.url;
  const got = Buffer.from(await (await fetch(new URL(link, S.base))).arrayBuffer());
  assert.equal(got.length, big.length);
});

test('права: посторонний — «не найдено»; чужой пропуск, подделанный пропуск, другая заявка — отказ; без файла — «не дошёл»', async () => {
  const meta = { filename: 'x.pdf', mime: 'application/pdf', size: 4 * MB, kind: 'other' };
  assert.equal((await other.req('POST', `/api/orders/${o.id}/documents/upload-url`, meta)).status, 404);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results/upload-url`, meta)).status, 404);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents/upload-url`, { ...meta, size: 101 * MB })).status, 413);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents/upload-url`, { ...meta, size: 0 })).status, 400);
  const r = (await owner.req('POST', `/api/orders/${o.id}/documents/upload-url`, meta)).body;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/uploads/complete`, { pass: r.pass })).status, 409, 'файл не положили');
  const [payload, sig] = r.pass.split('.');
  const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), u: other.user.id })).toString('base64url')}.${sig}`;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/uploads/complete`, { pass: forged })).status, 403, 'подделка');
  const o2 = (await other.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Чужая' })).body.order;
  assert.equal((await other.req('POST', `/api/orders/${o2.id}/uploads/complete`, { pass: r.pass })).status, 403, 'пропуск другой заявки');
  assert.equal((await other.req('POST', `/api/orders/${o.id}/uploads/complete`, { pass: r.pass })).status, 404, 'посторонний');
  // Ссылка на загрузку — не ссылка на скачивание.
  assert.equal((await fetch(new URL(r.upload_url.replace('/files/up/', '/files/'), S.base))).status, 404);
});

test('результат на 50 МБ: только исполнитель и только в работе; ИИ-проверка читает большой отчёт', async () => {
  const { makePdf } = await import('../tools/make-docs.mjs');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const meta = (size) => ({ filename: 'Отчёт об оценке.pdf', mime: 'application/pdf', size });
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results/upload-url`, meta(50 * MB))).status, 409, 'ещё не в работе');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/results/upload-url`, meta(50 * MB))).status, 403, 'заказчик результат не кладёт');
  // Настоящий PDF с текстом, раздутый до 50 МБ комментарием в конце (как отчёт с фото).
  const pdf = Buffer.concat([makePdf([['Отчёт об оценке квартиры. Итоговая стоимость 9 000 000 руб.']]), Buffer.from(`\n%${'x'.repeat(50 * MB)}\n`)]);
  const r = (await spec.req('POST', `/api/orders/${o.id}/results/upload-url`, meta(pdf.length))).body;
  const t0 = Date.now();
  assert.equal(await put(r.upload_url, pdf, r.content_type), 200);
  const c = await spec.req('POST', `/api/orders/${o.id}/uploads/complete`, { pass: r.pass });
  assert.equal(c.status, 201);
  assert.equal(c.body.document.kind, 'result');
  const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(ai.status, 201, JSON.stringify(ai.body));
  assert.ok(Date.now() - t0 < 20_000, 'загрузка и проверка 50 МБ — быстрее 20 с на стенде');
  assert.deepEqual(ai.body.ai.files.map((f) => [f.name, f.read]), [['Отчёт об оценке.pdf', true]], 'большой отчёт прочитан (раньше — до 10 МБ)');
});

test('Word больше 3 МБ отдаётся временной ссылкой из хранилища (ответ облака — не больше 3,5 МБ)', async () => {
  const { sendFile } = await import('../../src/ops/util.mjs');
  const calls = [];
  const res = { set: () => {}, redirect: (code, url) => calls.push([code, url]), send: () => calls.push(['send']) };
  await sendFile(res, S.providers, { buf: Buffer.alloc(4 * MB), filename: 'Отчёт.docx', mime: 'application/octet-stream' });
  assert.equal(calls[0][0], 303);
  assert.match(calls[0][1], /^\/files\//);
  const keys = [...S.providers.storage.objects.keys()].filter((k) => k.startsWith('tmp/'));
  assert.equal(keys.length, 1, 'во временной папке хранилища');
  await sendFile(res, S.providers, { buf: Buffer.alloc(100), filename: 'a.docx', mime: 'x' });
  assert.deepEqual(calls[1], ['send']);
});
