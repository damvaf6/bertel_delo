// ИИ (задача 1.8): модель как настройка (основная и запасная, только российские), вход через проблему, ассистент с раздельной
// памятью, ИИ-проверка результата по правилам модуля, дневной лимит. Без облака — поддельная модель и заглушки API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, login, makeOrg, addMember, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { loadConfig, ConfigError } from '../../src/config.mjs';
import { aiChain, createAi } from '../../src/providers/ai.mjs';
import { createOcr } from '../../src/providers/ocr.mjs';
import { makeFake } from '../../src/providers/fake.mjs';
import { parseJsonAnswer, LEGAL_NOTE } from '../../src/ai/ai.mjs';
import { PROBLEM_QUESTIONS } from '../tools/problem-questions.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { makePdf, makeDocx } from '../tools/make-docs.mjs';

let S, owner, other, head, member, dispatcher, spec, admin, org, orgB;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 7' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000801');
  other = await login(S, '+79990000802');
  head = await login(S, '+79990000803');
  member = await login(S, '+79990000804');
  dispatcher = await login(S, '+79990000805');
  spec = await login(S, '+79990000806');
  admin = await login(S, '+79990000807');
  org = await makeOrg(S.sql, 'Тестовое бюро ИИ');
  orgB = await makeOrg(S.sql, 'Тестовое чужое бюро');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, member.user.id, 'member');
  await addMember(S.sql, orgB.id, other.user.id, 'head');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

const aiCalls = () => S.providers.ai.calls;
const lastPrompt = () => aiCalls().at(-1).args.messages.map((m) => m.content).join('\n');

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

async function inWork(title = 'Тестовая квартира для ИИ') {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

const putResult = (o, body, name, type) => spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(body), {
  raw: true, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
});

// ——— Модель как настройка ———

test('настройки ИИ: только российские модели из списка, ключи обязательны, на prod — не поддельная', () => {
  const base = { APP_ENV: 'dev', DATABASE_URL: 'postgres://x/y' };
  assert.equal(loadConfig(base).providers.ai, 'fake');
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'openai' }), ConfigError, 'зарубежная модель');
  assert.throws(() => loadConfig({ ...base, AI_FALLBACK: 'chatgpt' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'yandexgpt' }), ConfigError, 'без ключа');
  assert.throws(() => loadConfig({ ...base, AI_FALLBACK: 'gigachat' }), ConfigError, 'без ключа');
  assert.throws(() => loadConfig({ ...base, AI_FALLBACK: 'fake' }), ConfigError, 'запасная совпадает с основной');
  assert.throws(() => loadConfig({ ...base, AI_DAILY_LIMIT: '0' }), ConfigError);
  const ok = loadConfig({ ...base, AI_PROVIDER: 'yandexgpt', AI_YANDEX_API_KEY: 'k', AI_YANDEX_FOLDER: 'f', AI_FALLBACK: 'gigachat', GIGACHAT_AUTH_KEY: 'g' });
  assert.equal(ok.ai.fallback, 'gigachat');
  assert.equal(ok.ai.yandex.model, 'yandexgpt/latest');
  const prod = (extra) => loadConfig({ APP_ENV: 'prod', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b',
    SMS_PROVIDER: 's', CALL_PROVIDER: 'c', PAYMENTS_PROVIDER: 'p', MAIL_PROVIDER: 'm', SIGN_PROVIDER: 'g', MAIL_INBOX_ADDRESS: 'zayavki@delo.example', PUBLIC_URL: 'https://delo.example',
    AI_PROVIDER: 'yandexgpt', AI_YANDEX_API_KEY: 'k', AI_YANDEX_FOLDER: 'f', ...extra });
  assert.ok(prod({}).live);
  assert.throws(() => prod({ AI_PROVIDER: 'fake' }), ConfigError);
  assert.throws(() => prod({ AI_FALLBACK: 'fake' }), ConfigError);
});

test('запасная модель: основная не ответила — отвечает запасная; обе молчат — ошибка', async () => {
  const a = Object.assign(makeFake('ai', { complete: async () => ({ text: 'основная', model: 'a' }) }), { driver: 'a' });
  const b = Object.assign(makeFake('ai', { complete: async () => ({ text: 'запасная', model: 'b' }) }), { driver: 'b' });
  const chain = aiChain([a, b]);
  assert.equal((await chain.complete({ purpose: 'assistant', messages: [] })).text, 'основная');
  a.script({ kind: 'fail' });
  const out = await chain.complete({ purpose: 'assistant', messages: [] });
  assert.deepEqual(out, { text: 'запасная', model: 'b', tokens: null, driver: 'b' });
  b.script({ kind: 'fail' });
  await assert.rejects(chain.complete({ purpose: 'assistant', messages: [] }));
  // Пустой ответ — тоже «не ответила».
  const empty = Object.assign(makeFake('ai', { complete: async () => ({ text: '  ', model: 'e' }) }), { driver: 'e' });
  const c = Object.assign(makeFake('ai', { complete: async () => ({ text: 'ок', model: 'c' }) }), { driver: 'c' });
  assert.equal((await aiChain([empty, c]).complete({ messages: [] })).model, 'c');
});

// Заглушка API поставщиков на локальном порту: проверяем, что ядро говорит с ними по их правилам.
async function stubServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, json] = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test('YandexGPT: запрос по OpenAI-совместимому API с ключом и папкой; сбой — понятная ошибка, без текста ответа', async () => {
  let fail = false;
  const stub = await stubServer(() => (fail ? [500, { error: 'секрет' }] : [200, { choices: [{ message: { content: 'Ответ YandexGPT' } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }]));
  try {
    const cfg = loadConfig({ APP_ENV: 'dev', DATABASE_URL: 'x', AI_PROVIDER: 'yandexgpt', AI_YANDEX_API_KEY: 'test-key', AI_YANDEX_FOLDER: 'b1test', AI_YANDEX_URL: `${stub.url}/v1/` });
    const ai = createAi(cfg);
    const out = await ai.complete({ purpose: 'assistant', messages: [{ role: 'user', content: 'Привет' }] });
    assert.deepEqual(out, { text: 'Ответ YandexGPT', model: 'yandexgpt:yandexgpt/latest', tokens: 17, driver: 'yandexgpt' });
    const req = stub.seen[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Api-Key test-key');
    const body = JSON.parse(req.body);
    assert.equal(body.model, 'gpt://b1test/yandexgpt/latest');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Привет' }]);
    fail = true;
    await assert.rejects(ai.complete({ messages: [] }), (e) => !/секрет/.test(e.message));
  } finally { await stub.close(); }
});

test('Yandex Vision OCR: по ключу или временным токеном из сервиса метаданных (без ключа); токен — один раз, в ошибках нет текста', async () => {
  let fail = false;
  const stub = await stubServer((req) => {
    if (req.url === '/meta') return [200, { access_token: 'iam-tok', expires_in: 43200, token_type: 'Bearer' }];
    return fail ? [403, { message: 'секрет' }] : [200, { result: { textAnnotation: { fullText: 'Цена 11 500 000 ₽' } } }];
  });
  try {
    const base = { APP_ENV: 'dev', DATABASE_URL: 'x', OCR_PROVIDER: 'yandex', AI_YANDEX_FOLDER: 'b1test', OCR_YANDEX_URL: `${stub.url}/ocr` };
    // По ключу.
    const byKey = createOcr(loadConfig({ ...base, AI_YANDEX_API_KEY: 'test-key' }));
    assert.deepEqual(await byKey.recognize({ buf: Buffer.from('png'), mime: 'image/png' }), { text: 'Цена 11 500 000 ₽' });
    const r1 = stub.seen.at(-1);
    assert.equal(r1.headers.authorization, 'Api-Key test-key');
    assert.equal(r1.headers['x-folder-id'], 'b1test');
    assert.equal(r1.headers['x-data-logging-enabled'], 'false');
    assert.equal(JSON.parse(r1.body).mimeType, 'PNG');
    // Без ключа и без способа входа — сервер не стартует; со способом «metadata» ключ не нужен.
    assert.throws(() => loadConfig(base), ConfigError);
    assert.throws(() => loadConfig({ ...base, OCR_YANDEX_AUTH: 'magic' }), ConfigError);
    const byMeta = createOcr(loadConfig({ ...base, OCR_YANDEX_AUTH: 'metadata', OCR_YANDEX_METADATA_URL: `${stub.url}/meta` }));
    await byMeta.recognize({ buf: Buffer.from('jpg'), mime: 'image/jpeg' });
    await byMeta.recognize({ buf: Buffer.from('jpg'), mime: 'image/jpeg' });
    const meta = stub.seen.filter((r) => r.url === '/meta');
    assert.equal(meta.length, 1, 'токен — один раз');
    assert.equal(meta[0].headers['metadata-flavor'], 'Google');
    const ocrs = stub.seen.filter((r) => r.url === '/ocr');
    assert.equal(ocrs.at(-1).headers.authorization, 'Bearer iam-tok');
    assert.equal(JSON.parse(ocrs.at(-1).body).mimeType, 'JPEG');
    fail = true;
    await assert.rejects(byMeta.recognize({ buf: Buffer.from('x'), mime: 'image/png' }), (e) => /403/.test(e.message) && !/секрет/.test(e.message));
  } finally { await stub.close(); }
});

test('GigaChat: токен доступа берётся один раз и используется повторно; YandexGPT упал — ответил GigaChat', async () => {
  const stub = await stubServer((req) => {
    if (req.url === '/oauth') return [200, { access_token: 'tok-1', expires_at: Date.now() + 30 * 60_000 }];
    if (req.url === '/yandex/chat/completions') return [503, {}];
    return [200, { choices: [{ message: { content: 'Ответ GigaChat' } }] }];
  });
  try {
    const cfg = loadConfig({ APP_ENV: 'dev', DATABASE_URL: 'x', AI_PROVIDER: 'yandexgpt', AI_YANDEX_API_KEY: 'k', AI_YANDEX_FOLDER: 'f', AI_YANDEX_URL: `${stub.url}/yandex`,
      AI_FALLBACK: 'gigachat', GIGACHAT_AUTH_KEY: 'basic-key', GIGACHAT_AUTH_URL: `${stub.url}/oauth`, GIGACHAT_URL: `${stub.url}/giga` });
    const ai = createAi(cfg);
    assert.deepEqual(await ai.complete({ messages: [{ role: 'user', content: 'a' }] }), { text: 'Ответ GigaChat', model: 'gigachat:GigaChat-Pro', tokens: null, driver: 'gigachat' });
    await ai.complete({ messages: [{ role: 'user', content: 'b' }] });
    const auth = stub.seen.filter((r) => r.url === '/oauth');
    assert.equal(auth.length, 1, 'токен — один раз');
    assert.equal(auth[0].headers.authorization, 'Basic basic-key');
    assert.match(auth[0].body, /scope=GIGACHAT_API_PERS/);
    const chats = stub.seen.filter((r) => r.url === '/giga/chat/completions');
    assert.equal(chats.length, 2);
    assert.equal(chats[0].headers.authorization, 'Bearer tok-1');
    assert.equal(JSON.parse(chats[0].body).model, 'GigaChat-Pro');
  } finally { await stub.close(); }
});

test('ответ модели в JSON: обёртки и пояснения вокруг не мешают; не JSON — null', () => {
  assert.deepEqual(parseJsonAnswer('Вот ответ:\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.equal(parseJsonAnswer('просто текст'), null);
  assert.equal(parseJsonAnswer('[1,2]'), null);
});

// ——— Вход через проблему ———

test('вход через проблему: разъяснение, что сделать самому, специалист и услуга; заявка-черновик из разбора — один раз', async () => {
  const problem = 'Суд назначил оценку квартиры в Москве при разделе имущества, что делать?';
  const r = await owner.req('POST', '/api/ai/problem', { text: problem });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.consultation;
  assert.ok(c.explanation.length > 10);
  assert.ok(c.self_steps.length > 0, 'что сделать самому');
  assert.ok(c.specialist, 'к какому специалисту');
  assert.match(c.disclaimer, /не юридическая услуга/);
  assert.equal(c.service.service, 'realty');
  assert.equal(c.service.name, 'Оценка недвижимости');
  assert.deepEqual(c.fields, { purpose: 'court', region: 'moscow' });
  // В модель ушёл перечень услуг модуля и сам вопрос.
  assert.match(lastPrompt(), /expertise\/realty/);
  assert.match(lastPrompt(), /раздел/);

  // Чужой разбор не виден и заявку из него не создать.
  assert.equal((await other.req('POST', `/api/ai/consultations/${c.id}/order`, {})).status, 404);
  const made = await owner.req('POST', `/api/ai/consultations/${c.id}/order`, {});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const order = (await owner.req('GET', `/api/orders/${made.body.order_id}`)).body.order;
  assert.equal(order.status, 'new', 'черновик: отправляет человек');
  assert.equal(order.service, 'realty');
  assert.equal(order.fields.purpose, 'court');
  assert.equal(order.fields.region, 'moscow');
  assert.equal(order.fields.comment, problem);
  assert.equal((await owner.req('POST', `/api/ai/consultations/${c.id}/order`, {})).status, 409, 'второй раз — нельзя');
  const [row] = await S.sql`select details from audit_log where action = 'order.create' and subject_id = ${order.id}`;
  assert.equal(row.details.via, 'ai_problem');
});

test('вход через проблему: человек может выбрать другую услугу и организацию; ИИ не нашёл услугу — заявка только с выбором', async () => {
  const none = (await member.req('POST', '/api/ai/problem', { text: 'Сосед шумит по ночам' })).body.consultation;
  assert.equal(none.service, null);
  assert.equal((await member.req('POST', `/api/ai/consultations/${none.id}/order`, {})).status, 400);
  assert.equal((await member.req('POST', `/api/ai/consultations/${none.id}/order`, { service: 'expertise/goods', org_id: orgB.id })).status, 404, 'чужая организация');
  const made = await member.req('POST', `/api/ai/consultations/${none.id}/order`, { service: 'expertise/goods', org_id: org.id });
  assert.equal(made.status, 201);
  const o = (await head.req('GET', `/api/orders/${made.body.order_id}`)).body.order;
  assert.equal(o.org_id, org.id, 'руководитель видит заявку сотрудника');
  assert.equal(o.service, 'goods');
  assert.deepEqual(Object.keys(o.fields), ['comment']);
});

test('вход через проблему: услугу настоящая модель пишет по-разному — код, «модуль/услуга», название; всё узнаётся', async () => {
  const orig = S.providers.ai.complete;
  try {
    for (const service of [{ module: 'expertise', service: 'realty' }, 'expertise/realty', 'realty', 'Оценка недвижимости', { module: 'Экспертиза и оценка', service: 'Оценка недвижимости' }]) {
      S.providers.ai.complete = async () => ({ text: JSON.stringify({ explanation: 'Нужна оценка квартиры', self_steps: ['Соберите документы'], specialist: 'оценщик', service, fields: { purpose: 'court' } }), model: 'fake' });
      const r = await owner.req('POST', '/api/ai/problem', { text: 'Суд назначил оценку квартиры' });
      assert.equal(r.status, 201, JSON.stringify(service));
      assert.equal(r.body.consultation.service?.service, 'realty', JSON.stringify(service));
      assert.deepEqual(r.body.consultation.fields, { purpose: 'court' });
    }
    S.providers.ai.complete = async () => ({ text: JSON.stringify({ explanation: 'x', service: 'Оценка луны' }), model: 'fake' });
    assert.equal((await owner.req('POST', '/api/ai/problem', { text: 'Оцените луну' })).body.consultation.service, null);
  } finally { S.providers.ai.complete = orig; }
});

test('вход через проблему: модель ответила не по форме — человек видит её текст, услугу и поля выдумать нельзя', async () => {
  S.providers.ai.reset();
  const fake = S.providers.ai;
  // Подменяем ответ поддельной модели одним вызовом.
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '{"explanation":"x","self_steps":["шаг"],"service":{"module":"expertise","service":"hack"},"fields":{"purpose":"bad"}}', model: 'fake' });
  try {
    const c = (await owner.req('POST', '/api/ai/problem', { text: 'тест формы' })).body.consultation;
    assert.equal(c.service, null);
    assert.deepEqual(c.fields, {});
    S.providers.ai.complete = async () => ({ text: 'Просто текст без JSON', model: 'fake' });
    const t = (await owner.req('POST', '/api/ai/problem', { text: 'тест текста' })).body.consultation;
    assert.equal(t.explanation, 'Просто текст без JSON');
    assert.equal(t.service, null);
  } finally { S.providers.ai.complete = orig; fake.reset(); }
  assert.equal((await owner.req('POST', '/api/ai/problem', { text: '' })).status, 400);
  assert.equal((await owner.req('POST', '/api/ai/problem', { text: 'x'.repeat(4001) })).status, 400);
});

// Признаки юридической консультации в ответе: совет судиться, статья закона, прогноз исхода (2.41).
const LEGAL_ADVICE_RE = /подайте[^.]*иск|стать[яиеюё]й?\s*\d|ст\.\s*\d|(?:ГК|ГПК|УК|КоАП)\s*РФ|шанс\w*[^.]{0,20}выигр|выиграете|исков\w* давност/i;

test('вход через проблему (2.41): 20 типичных вопросов по оценке — понятный ответ, без юридической консультации, всегда «что сделать самому» и «к кому»', async () => {
  const u = await login(S, '+79990000809');
  for (const q of PROBLEM_QUESTIONS) {
    const r = await u.req('POST', '/api/ai/problem', { text: q.text });
    assert.equal(r.status, 201, q.text);
    const c = r.body.consultation;
    assert.ok(c.explanation.length > 20 && c.explanation.length <= 3000, q.text);
    assert.ok(c.self_steps.length >= 1, `нет шагов «что сделать самому»: ${q.text}`);
    assert.ok(c.specialist, `нет «к кому обратиться»: ${q.text}`);
    assert.equal(c.service?.service, q.service, q.text);
    assert.match(c.disclaimer, /не юридическая услуга/);
    for (const x of [c.explanation, ...c.self_steps, c.specialist]) assert.doesNotMatch(x, LEGAL_ADVICE_RE, q.text);
    assert.equal(c.legal_note, q.legal ? LEGAL_NOTE : null, q.text);
  }
  assert.match(lastPrompt(), /Юридических консультаций не давай/);
});

test('вход через проблему (2.41): модель дала юридический совет — он убирается, человеку — «это к юристу»; пустой ответ — всё равно с шагом', async () => {
  const orig = S.providers.ai.complete;
  const u = await login(S, '+79990000810');
  try {
    S.providers.ai.complete = async () => ({ text: JSON.stringify({
      explanation: 'Нужна независимая оценка ущерба. Подайте иск к страховой по ст. 15 ГК РФ — шансы выиграть высокие. Отчёт оценщика суд примет как доказательство.',
      self_steps: ['Соберите документы о ДТП', 'Обжалуйте решение страховой через претензию', 'Сфотографируйте повреждения'],
      specialist: 'Эксперт-оценщик', service: 'expertise/vehicle', fields: {},
    }), model: 'fake' });
    const c = (await u.req('POST', '/api/ai/problem', { text: 'Страховая заплатила мало за ДТП' })).body.consultation;
    assert.equal(c.explanation, 'Нужна независимая оценка ущерба. Отчёт оценщика суд примет как доказательство.');
    assert.deepEqual(c.self_steps, ['Соберите документы о ДТП', 'Сфотографируйте повреждения']);
    assert.equal(c.legal_note, LEGAL_NOTE);
    assert.equal(c.service.service, 'vehicle');

    S.providers.ai.complete = async () => ({ text: JSON.stringify({ explanation: 'По ст. 1064 ГК РФ виновник обязан возместить вред.', self_steps: [], specialist: null, service: null }), model: 'fake' });
    const e = (await u.req('POST', '/api/ai/problem', { text: 'Имею ли я право требовать деньги с соседа?' })).body.consultation;
    assert.match(e.explanation, /не нашёл подходящей услуги/);
    assert.equal(e.self_steps.length, 1, 'всегда хотя бы один шаг «что сделать самому»');
    assert.equal(e.specialist, 'Юрист');
    assert.equal(e.legal_note, LEGAL_NOTE);

    S.providers.ai.complete = async () => ({ text: JSON.stringify({ explanation: 'Нужна оценка квартиры.', self_steps: [], specialist: '', service: 'expertise/realty' }), model: 'fake' });
    const f = (await u.req('POST', '/api/ai/problem', { text: 'Оценка квартиры для банка' })).body.consultation;
    assert.equal(f.self_steps.length, 1);
    assert.equal(f.specialist, 'Оценка недвижимости');
    assert.equal(f.legal_note, null);
  } finally { S.providers.ai.complete = orig; }
});

test('модель недоступна — понятный ответ, действие не ломается; дневной лимит обращений', async () => {
  S.providers.ai.script({ kind: 'fail' });
  const r = await owner.req('POST', '/api/assistant', { text: 'Привет' });
  assert.equal(r.status, 503);
  assert.match(r.body.message, /недоступен/);
  S.providers.ai.script();
  assert.equal((await owner.req('GET', '/api/assistant')).body.messages.length, 0, 'неудачный вопрос не сохраняется');

  // Лимит — настройка AI_DAILY_LIMIT; здесь уменьшаем его на время проверки.
  const u = await login(S, '+79990000899');
  const limit = S.cfg.ai.dailyLimit;
  S.cfg.ai.dailyLimit = 2;
  try {
    assert.equal((await u.req('POST', '/api/assistant', { text: '1' })).status, 201);
    assert.equal((await u.req('POST', '/api/ai/problem', { text: 'квартира' })).status, 201);
    const over = await u.req('POST', '/api/assistant', { text: '3' });
    assert.equal(over.status, 429);
    assert.match(over.body.message, /Лимит/);
    assert.equal((await owner.req('POST', '/api/assistant', { text: 'у другого свой лимит' })).status, 429, 'у владельца уже 2 обращения за сутки');
  } finally { S.cfg.ai.dailyLimit = limit; }
});

// ——— Ассистент ———

test('ассистент: память раздельная — личная и по организации; чужая организация — «не найдено»; очистить можно только свою', async () => {
  assert.equal((await head.req('POST', '/api/assistant', { text: 'ЛИЧНЫЙ-ВОПРОС-1' })).status, 201);
  assert.equal((await head.req('POST', '/api/assistant', { text: 'РАБОЧИЙ-ВОПРОС-1', org_id: org.id })).status, 201);
  // В рабочий разговор не попала личная память, и наоборот.
  S.providers.ai.reset();
  await head.req('POST', '/api/assistant', { text: 'рабочий 2', org_id: org.id });
  assert.match(lastPrompt(), /РАБОЧИЙ-ВОПРОС-1/);
  assert.doesNotMatch(lastPrompt(), /ЛИЧНЫЙ-ВОПРОС-1/);
  assert.match(lastPrompt(), /организация «Тестовое бюро ИИ»/);
  await head.req('POST', '/api/assistant', { text: 'личный 2' });
  assert.match(lastPrompt(), /ЛИЧНЫЙ-ВОПРОС-1/);
  assert.doesNotMatch(lastPrompt(), /РАБОЧИЙ-ВОПРОС-1/);
  // Коллега по организации не видит память руководителя (память — своя у каждого).
  S.providers.ai.reset();
  await member.req('POST', '/api/assistant', { text: 'вопрос сотрудника', org_id: org.id });
  assert.doesNotMatch(lastPrompt(), /РАБОЧИЙ-ВОПРОС-1/);
  assert.ok(!(await member.req('GET', `/api/assistant?org=${org.id}`)).body.messages.some((m) => /РАБОЧИЙ/.test(m.body)));

  const g = (await head.req('GET', `/api/assistant?org=${org.id}`)).body;
  assert.deepEqual(g.scopes.map((s) => s.name), ['Личное', 'Тестовое бюро ИИ']);
  assert.equal(g.messages.length, 4);
  assert.equal((await head.req('GET', `/api/assistant?org=${orgB.id}`)).status, 404, 'чужая организация');
  assert.equal((await head.req('POST', '/api/assistant', { text: 'x', org_id: orgB.id })).status, 404);
  assert.equal((await head.req('GET', '/api/assistant?org=abc')).status, 404);

  assert.equal((await head.req('DELETE', `/api/assistant?org=${org.id}`)).status, 204);
  assert.equal((await head.req('GET', `/api/assistant?org=${org.id}`)).body.messages.length, 0);
  assert.equal((await head.req('GET', '/api/assistant')).body.messages.length, 4, 'личная память не тронута');
  assert.equal((await member.req('GET', `/api/assistant?org=${org.id}`)).body.messages.length, 2, 'память сотрудника не тронута');
  assert.equal((await other.req('DELETE', `/api/assistant?org=${org.id}`)).status, 404);
});

test('ассистент: заявку можно взять только видимую и только в «её» память; в модель — сводка без имён и телефонов', async () => {
  const personal = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Личная квартира владельца' })).body.order;
  await owner.req('PATCH', `/api/orders/${personal.id}`, { fields: FIELDS });
  const orgOrder = (await member.req('POST', '/api/orders', { module: 'expertise', service: 'land', title: 'Участок бюро', org_id: org.id })).body.order;

  S.providers.ai.reset();
  assert.equal((await owner.req('POST', '/api/assistant', { text: 'Что дальше?', order_id: personal.id })).status, 201);
  const p = lastPrompt();
  assert.match(p, /Личная квартира владельца/);
  assert.match(p, /Адрес объекта: г\. Москва, тестовая ул\., 7/);
  assert.match(p, /Купля-продажа/, 'вариант выбора — названием');
  assert.doesNotMatch(p, /\+7999/);

  assert.equal((await other.req('POST', '/api/assistant', { text: 'x', order_id: personal.id })).status, 404, 'чужая заявка');
  assert.equal((await member.req('POST', '/api/assistant', { text: 'x', order_id: orgOrder.id })).status, 404, 'дело организации — не в личную память');
  assert.equal((await member.req('POST', '/api/assistant', { text: 'x', order_id: orgOrder.id, org_id: org.id })).status, 201);
  assert.equal((await head.req('POST', '/api/assistant', { text: 'x', order_id: personal.id, org_id: org.id })).status, 404);
  const list = (await member.req('GET', `/api/assistant?org=${org.id}`)).body.orders.map((o) => o.id);
  assert.ok(list.includes(orgOrder.id));
  assert.ok(!(await member.req('GET', '/api/assistant')).body.orders.some((o) => o.id === orgOrder.id));

  // Сотрудник ушёл из организации — раздел памяти организации ему больше не доступен.
  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${member.user.id}`;
  try {
    assert.equal((await member.req('GET', `/api/assistant?org=${org.id}`)).status, 404);
    assert.ok(!(await member.req('GET', '/api/assistant')).body.scopes.some((s) => s.org_id === org.id));
  } finally {
    await S.sql`insert into org_members (org_id, user_id, role) values (${org.id}, ${member.user.id}, 'member')`;
  }
});

test('ассистент исполнителя: дело — в личной памяти, пока оно за ним; сняли с дела — сообщения о нём скрыты и в модель не идут', async () => {
  const o = await inWork('Квартира исполнителя');
  assert.equal((await spec.req('POST', '/api/assistant', { text: 'СЕКРЕТ-ДЕЛА: как оценить?', order_id: o.id })).status, 201);
  assert.equal((await spec.req('POST', '/api/assistant', { text: 'Общий вопрос без дела' })).status, 201);
  assert.equal((await spec.req('GET', '/api/assistant')).body.messages.length, 4);
  // Диспетчер передал дело другому исполнителю — прежний теряет доступ.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'in_work', reason: 'Передать другому' })).status, 200);
  const g = (await spec.req('GET', '/api/assistant')).body;
  assert.equal(g.messages.length, 2);
  assert.equal(g.hidden, 2);
  assert.ok(!g.messages.some((m) => /СЕКРЕТ-ДЕЛА/.test(m.body)));
  S.providers.ai.reset();
  await spec.req('POST', '/api/assistant', { text: 'ещё вопрос' });
  assert.doesNotMatch(lastPrompt(), /СЕКРЕТ-ДЕЛА/);
  assert.match(lastPrompt(), /Общий вопрос без дела/);
});

// ——— ИИ-проверка результата ———

test('ИИ-проверка: исполнитель перед сдачей, диспетчер на проверке; подсказки по каждому правилу, отметки ставит человек', async () => {
  const o = await inWork('Квартира для ИИ-проверки');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 400, 'без файла результата');
  assert.equal((await putResult(o, 'Отчёт об оценке. Итог 5 000 000 руб. Есть опечатка в разделе 2.', 'отчёт.txt', 'text/plain')).status, 201);
  assert.equal((await putResult(o, '%PDF-1.4 ...', 'приложение.pdf', 'application/pdf')).status, 201);
  // До сдачи: заказчик и диспетчер не запускают; посторонний не видит.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/review/ai`)).status, 403);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/review/ai`)).status, 403);
  assert.equal((await other.req('POST', `/api/orders/${o.id}/review/ai`)).status, 404);

  S.providers.ai.reset();
  let r = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ai.round, 1, 'перед сдачей — будущий круг');
  assert.equal(r.body.ai.side, 'executor');
  const rules = (await spec.req('GET', `/api/orders/${o.id}/review`)).body.checks.map((c) => c.id);
  assert.deepEqual(r.body.ai.items.map((i) => i.id), rules, 'по каждому правилу модуля');
  assert.equal(r.body.ai.items.find((i) => i.id === 'technical').hint, 'attention');
  assert.equal(r.body.ai.items.find((i) => i.id === 'calculation').hint, 'ok');
  assert.deepEqual(r.body.ai.files.map((f) => [f.name, f.read]), [['отчёт.txt', true], ['приложение.pdf', false]]);
  assert.match(lastPrompt(), /Есть опечатка в разделе 2/, 'текст результата ушёл в модель');
  assert.match(lastPrompt(), /- analogs: /);

  // Исполнитель видит подсказки у себя; заказчику — ни подсказок, ни отметок.
  let view = (await spec.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.equal(view.ai.items.length, rules.length);
  assert.equal(view.can_ai, true);
  const cust = (await owner.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.equal(cust.ai, undefined);
  assert.equal(cust.details, false);

  // Сдал — диспетчер видит подсказку исполнителя для этого круга и запускает свою; отметки ИИ не ставит.
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  view = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.equal(view.ai.side, 'executor');
  assert.equal(view.summary.unchecked, view.summary.total, 'ИИ ничего не отметил сам');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 403, 'после сдачи исполнитель не запускает');
  r = await dispatcher.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(r.status, 201);
  assert.equal(r.body.ai.side, 'dispatcher');
  assert.equal(r.body.ai.round, 1);
  assert.equal((await admin.req('POST', `/api/orders/${o.id}/review/ai`)).status, 403, 'администратор только читает');
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body.summary.unchecked, rules.length);
});

test('ИИ-проверка: модель ответила не по всем правилам — по остальным «посмотрите сами»; нечитаемый файл — внимание', async () => {
  const o = await inWork('Квартира: только PDF');
  assert.equal((await putResult(o, '%PDF', 'отчёт.pdf', 'application/pdf')).status, 201);
  const r = (await spec.req('POST', `/api/orders/${o.id}/review/ai`)).body.ai;
  assert.ok(r.items.every((i) => i.hint === 'attention'));
  const orig = S.providers.ai.complete;
  S.providers.ai.complete = async () => ({ text: '{"items":[{"id":"requisites","hint":"ok","note":"Реквизиты на месте"}]}', model: 'fake' });
  try {
    const p = (await spec.req('POST', `/api/orders/${o.id}/review/ai`)).body.ai;
    assert.equal(p.items.find((i) => i.id === 'requisites').hint, 'ok');
    assert.match(p.items.find((i) => i.id === 'calculation').note, /проверьте сами/);
  } finally { S.providers.ai.complete = orig; }
});

test('ИИ-проверка отчёта в PDF и Word (2.1): текст по страницам уходит в модель, отмеченные места — цитата, файл и страница', async () => {
  const o = await inWork('Квартира: отчёт в PDF и Word');
  const pdf = makePdf([
    ['Заключение № 7/2026 от 01.10.2026', 'Эксперт: Тестов Т. Т.'],
    ['Итоговая стоимость: 12 000 000 руб.', 'Здесь опечатка в слове «стоимасть».'],
  ]);
  const docx = makeDocx(['Приложение 1. Аналоги', 'Аналог 1: ул. Тестовая, 5 — 11 900 000 руб.', '\fПриложение 2. Фото объекта']);
  assert.equal((await putResult(o, pdf, 'Отчёт об оценке.pdf', 'application/pdf')).status, 201);
  assert.equal((await putResult(o, docx, 'Приложения.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).status, 201);
  S.providers.ai.reset();
  const ai = (await spec.req('POST', `/api/orders/${o.id}/review/ai`)).body.ai;
  assert.deepEqual(ai.files.map((f) => [f.name, f.read]), [['Отчёт об оценке.pdf', true], ['Приложения.docx', true]]);
  const prompt = lastPrompt();
  assert.match(prompt, /--- стр\. 2 ---\nИтоговая стоимость: 12 000 000 руб\./, 'PDF — по страницам');
  assert.match(prompt, /Аналог 1: ул\. Тестовая, 5/, 'Word прочитан');
  assert.match(prompt, /--- стр\. 2 ---\nПриложение 2\. Фото объекта/, 'разрыв страницы в Word');
  assert.match(prompt, /точных цитат/);
  const tech = ai.items.find((i) => i.id === 'technical');
  assert.equal(tech.hint, 'attention');
  // Модель привела две цитаты: настоящую и выдуманную — показывается только настоящая, с файлом и страницей.
  assert.deepEqual(tech.marks, [{ file: 'Отчёт об оценке.pdf', where: 'стр. 2', quote: 'Здесь опечатка в слове «стоимасть».' }]);
  assert.ok(ai.items.filter((i) => i.id !== 'technical').every((i) => Array.isArray(i.marks) && i.marks.length === 0));
  assert.equal(ai.items.find((i) => i.id === 'requisites').hint, 'ok', 'номер заключения в PDF найден');
  // Диспетчер после сдачи видит те же места.
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const view = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.deepEqual(view.ai.items.find((i) => i.id === 'technical').marks, tech.marks);
});

test('чтение отчёта (2.1): повреждённый PDF и Word, картинка, пустой файл — «не прочитан»; длинный текст обрезается с пометкой', async () => {
  const o = await inWork('Квартира: нечитаемые файлы');
  assert.equal((await putResult(o, '%PDF-1.7 сломан', 'битый.pdf', 'application/pdf')).status, 201);
  assert.equal((await putResult(o, 'PK не архив', 'битый.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).status, 201);
  assert.equal((await putResult(o, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'фото.jpg', 'image/jpeg')).status, 201);
  assert.equal((await putResult(o, makePdf([['   ']]), 'пустой.pdf', 'application/pdf')).status, 201);
  assert.equal((await putResult(o, 'Итог 1 000 руб. '.repeat(3000), 'длинный.txt', 'text/plain')).status, 201);
  const ai = (await spec.req('POST', `/api/orders/${o.id}/review/ai`)).body.ai;
  assert.deepEqual(ai.files.map((f) => [f.name, f.read]), [['битый.pdf', false], ['битый.docx', false], ['фото.jpg', false], ['пустой.pdf', false], ['длинный.txt', true]]);
  assert.equal(ai.files.find((f) => f.name === 'длинный.txt').truncated, true);
  assert.match(lastPrompt(), /не поместил/);
});

test('модель ИИ — администратору видно, какая работает и сколько обращений; остальным — «не найдено»', async () => {
  const r = await admin.req('GET', '/api/admin/ai');
  assert.equal(r.status, 200);
  assert.equal(r.body.primary.driver, 'fake');
  assert.equal(r.body.fallback, null);
  assert.equal(r.body.daily_limit, 50);
  assert.ok(r.body.day.total > 0);
  assert.equal((await dispatcher.req('GET', '/api/admin/ai')).status, 404);
  assert.equal((await owner.req('GET', '/api/admin/ai')).status, 404);
  // В журнал обращений тексты не пишутся.
  const cols = (await S.sql`select column_name from information_schema.columns where table_name = 'ai_usage'`).map((c) => c.column_name);
  assert.deepEqual(cols.sort(), ['at', 'cost_kop', 'id', 'model', 'ok', 'purpose', 'tokens', 'user_id']);
  assert.deepEqual(Object.keys(r.body.month).sort(), ['budget_rub', 'calls', 'price_rub_per_1k', 'spent_rub', 'tokens']);
  assert.equal(r.body.month.spent_rub, 0, 'поддельная модель ничего не стоит');
});

test('предел расхода за месяц: дошли — модель не вызывается, понятный ответ; прошлый месяц не в счёт; находки ИИ-проверки — без модели', async () => {
  const before = S.cfg.ai.budgetRub;
  try {
    S.cfg.ai.budgetRub = 900;
    await S.sql`insert into ai_usage (user_id, purpose, model, ok, tokens, cost_kop, at)
                values (${admin.user.id}, 'assistant', 'yandexgpt:test', true, 100000, 80000, now() - interval '40 days')`;
    const ok = await owner.req('POST', '/api/assistant', { text: 'Вопрос в пределах расхода' });
    assert.equal(ok.status, 201, 'расход прошлого месяца не в счёт');
    await S.sql`insert into ai_usage (user_id, purpose, model, ok, tokens, cost_kop) values (${admin.user.id}, 'assistant', 'yandexgpt:test', true, 150000, 90000)`;
    const calls = aiCalls().length;
    const r = await owner.req('POST', '/api/assistant', { text: 'Ещё вопрос' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'ai_budget');
    assert.match(r.body.message, /Лимит расхода/);
    assert.equal(aiCalls().length, calls, 'модель не вызывалась');
    const m = (await admin.req('GET', '/api/admin/ai')).body.month;
    assert.equal(m.spent_rub, 900);
    assert.equal(m.budget_rub, 900);
  } finally {
    S.cfg.ai.budgetRub = before;
    await S.sql`delete from ai_usage where model = 'yandexgpt:test'`;
  }
});

test('расход считается по токенам поставщика, а без них — с запасом по длине текста', async () => {
  const before = S.providers.ai.complete;
  try {
    S.providers.ai.complete = async () => ({ text: 'ответ', model: 'yandexgpt:test2', tokens: 2500, driver: 'yandexgpt' });
    assert.equal((await owner.req('POST', '/api/assistant', { text: 'Сколько стоит?' })).status, 201);
    S.providers.ai.complete = async () => ({ text: 'ответ', model: 'yandexgpt:test2', tokens: null, driver: 'yandexgpt' });
    assert.equal((await owner.req('POST', '/api/assistant', { text: 'Без токенов' })).status, 201);
    const rows = await S.sql`select tokens, cost_kop from ai_usage where model = 'yandexgpt:test2' order by id`;
    assert.deepEqual(rows[0], { tokens: 2500, cost_kop: 150 }, '2500 токенов по 0,60 ₽ за 1000 = 1,50 ₽');
    assert.ok(rows[1].tokens > 50, 'оценка по длине запроса');
  } finally {
    S.providers.ai.complete = before;
    await S.sql`delete from ai_usage where model = 'yandexgpt:test2'`;
  }
});
