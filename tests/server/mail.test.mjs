// Заявка по письму (задача 1.9): адрес подключается и подтверждается кодом; письмо с вложениями → ИИ разбирает →
// заявка-черновик и ответ номером; ответ «Отправить» отправляет; ход заявки и готовый результат — в ту же переписку.
// Чужие и поддельные письма не принимаются. Без облака — поддельная почта и поддельная модель.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, setPlatformRole, makeSpecialist, TEST_TOKEN, signResults } from '../helpers.mjs';
import { loadConfig, ConfigError } from '../../src/config.mjs';
import { freshText, normEmail, cleanMailAnswer } from '../../src/mail/inbound.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, other, head, member, dispatcher, spec, org;
const OWNER_MAIL = 'owner-test@example.ru';
const ru = (iso) => iso.split('-').reverse().join('.');

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000901');
  other = await login(S, '+79990000902');
  head = await login(S, '+79990000903');
  member = await login(S, '+79990000904');
  dispatcher = await login(S, '+79990000905');
  spec = await login(S, '+79990000906');
  org = await makeOrg(S.sql, 'Тестовая юрфирма по письмам');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, member.user.id, 'member');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
  await connect(owner, OWNER_MAIL);
});
after(async () => { await S?.close(); });
beforeEach(() => { S.providers.mail.calls.length = 0; });

const sent = () => S.providers.mail.calls.filter((c) => c.method === 'send').map((c) => c.args);
const lastSent = () => sent().at(-1);

async function connect(c, email) {
  await S.sql`update mail_addresses set code_sent_at = now() - interval '2 minutes' where user_id = ${c.user.id}`;
  const r = await c.req('POST', '/api/me/mail', { email });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = lastSent().text.match(/\d{6}/)[0];
  const ok = await c.req('POST', '/api/me/mail/confirm', { code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return ok.body;
}

async function letter(body) {
  const r = await fetch(`${S.base}/__test/mail/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-control': TEST_TOKEN, 'x-delo-request': '1' }, body: JSON.stringify(body),
  });
  assert.equal(r.status, 200);
  return r.json();
}

const file = (filename, text) => ({ filename, content_type: 'text/plain', base64: Buffer.from(text).toString('base64') });
const deadline = () => addDays(todayMsk(), 20);

const flatLetter = (extra = {}) => ({
  from: `Тестовый Заказчик <${OWNER_MAIL}>`,
  subject: 'Оценка квартиры для продажи',
  text: `Добрый день! Нужна оценка квартиры в Москве для продажи.\nАдрес: г. Москва, тестовая ул., 1\nПлощадь 54 кв. м\nСрок до ${ru(deadline())}`,
  attachments: [file('выписка ЕГРН.txt', 'тестовая выписка')],
  ...extra,
});

// ——— Настройки и разбор ———

test('настройки почты: особый адрес обязателен для настоящей почты; разбор адреса и текста письма', () => {
  const base = { APP_ENV: 'dev', DATABASE_URL: 'postgres://x/y' };
  assert.equal(loadConfig(base).mail.inbox, 'zayavki@delo.test');
  assert.throws(() => loadConfig({ ...base, MAIL_PROVIDER: 'postbox' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, MAIL_INBOX_ADDRESS: 'не адрес' }), ConfigError);
  assert.equal(normEmail('Иван <Ivan@Example.RU>'), 'ivan@example.ru');
  assert.equal(normEmail('нет адреса'), null);
  assert.equal(freshText('Отправить\n\nпн, 1 окт. 2026 г. в 10:00, БЕРТЕЛ Дело пишет:\n> старое'), 'Отправить');
  assert.equal(freshText('Текст\n-- \nПодпись'), 'Текст');
});

test('разбор ответа ИИ: только услуги и поля из перечня, неверные значения и даты отбрасываются', () => {
  const reg = S.app.locals.registry;
  const p = cleanMailAnswer(reg, JSON.stringify({
    service: { module: 'expertise', service: 'realty' }, title: 'Квартира',
    fields: { purpose: 'deal', region: 'луна', area: 'много', address: 'г. Москва, тест', comment: 'x', hacker: '1' },
    deadline: '2000-01-01', basis: 'court', basis_number: '2-1/2026', basis_date: '2099-01-01', basis_file: 'чужой.pdf',
  }), ['определение.pdf']);
  assert.equal(p.def.service.id, 'realty');
  assert.deepEqual(p.fields, { purpose: 'deal', address: 'г. Москва, тест' });
  assert.equal(p.deadline, null);
  assert.equal(p.basis_kind, 'court');
  assert.equal(p.basis_date, null);
  assert.equal(p.basis_file, null);
  assert.equal(cleanMailAnswer(reg, JSON.stringify({ service: { module: 'expertise', service: 'cosmos' } }), []).def, null);
  assert.equal(cleanMailAnswer(reg, 'не JSON', []).def, null);
});

// ——— Подключение адреса ———

test('адрес почты: код письмом, неверный код, подтверждение; адрес одного человека другому не подключить', async () => {
  const g = await owner.req('GET', '/api/me/mail');
  assert.equal(g.body.inbox, 'zayavki@delo.test');
  assert.deepEqual({ email: g.body.address.email, confirmed: g.body.address.confirmed }, { email: OWNER_MAIL, confirmed: true });

  assert.equal((await other.req('POST', '/api/me/mail', { email: 'плохой' })).status, 400);
  assert.equal((await other.req('POST', '/api/me/mail', { email: 'zayavki@delo.test' })).status, 400);
  assert.equal((await other.req('POST', '/api/me/mail', { email: OWNER_MAIL.toUpperCase() })).status, 409, 'чужой подтверждённый адрес');

  assert.equal((await other.req('POST', '/api/me/mail', { email: 'other-test@example.ru' })).status, 200);
  assert.equal(lastSent().to, 'other-test@example.ru');
  assert.equal((await other.req('POST', '/api/me/mail', { email: 'other-test@example.ru' })).status, 429, 'не чаще раза в минуту');
  assert.equal((await other.req('POST', '/api/me/mail/confirm', { code: '000000' })).status, 400);
  const code = lastSent().text.match(/\d{6}/)[0];
  const [{ code_hash: hash }] = await S.sql`select code_hash from mail_addresses where user_id = ${other.user.id}`;
  assert.ok(hash.length === 64 && !hash.includes(code), 'код хранится только хэшем');
  assert.equal((await other.req('POST', '/api/me/mail/confirm', { code })).body.address.confirmed, true);
  assert.equal((await other.req('POST', '/api/me/mail/confirm', { code })).status, 400, 'код одноразовый');

  // От имени организации — только своей.
  assert.equal((await other.req('PATCH', '/api/me/mail', { org_id: org.id })).status, 404);
  assert.equal((await head.req('PATCH', '/api/me/mail', { org_id: org.id })).status, 400, 'сначала адрес');
  // Отключить — письма с адреса больше не принимаются.
  assert.equal((await other.req('DELETE', '/api/me/mail')).status, 204);
  assert.equal((await other.req('GET', '/api/me/mail')).body.address, null);
});

// ——— Письмо → заявка ———

test('письмо с вложением → заявка-черновик с полями, сроком и файлом; ответ номером в ту же переписку', async () => {
  const r = await letter(flatLetter());
  assert.equal(r.inbound.outcome, 'created');
  const id = r.inbound.order_id;
  const o = (await owner.req('GET', `/api/orders/${id}`)).body;
  assert.equal(o.order.status, 'new', 'ИИ не отправляет заявку сам');
  assert.equal(o.order.service, 'realty');
  assert.equal(o.order.deadline, deadline());
  assert.equal(o.order.fields.purpose, 'deal');
  assert.equal(o.order.fields.region, 'moscow');
  assert.equal(o.order.fields.object_type, 'flat');
  assert.equal(o.order.fields.address, 'г. Москва, тестовая ул., 1');
  assert.equal(o.order.fields.area, 54);
  assert.match(o.order.fields.comment, /Нужна оценка квартиры/);
  assert.equal(o.mail.email, OWNER_MAIL);
  const docs = (await owner.req('GET', `/api/orders/${id}/documents`)).body.documents;
  assert.deepEqual(docs.map((d) => [d.filename, d.kind]), [['выписка ЕГРН.txt', 'other']]);

  const ans = lastSent();
  assert.equal(ans.to, OWNER_MAIL);
  assert.equal(ans.inReplyTo, r.message_id, 'ответ в ту же переписку');
  assert.match(ans.subject, new RegExp(`Заявка № ${id.slice(0, 8).toUpperCase()}`));
  assert.match(ans.text, /черновиком/);
  assert.match(ans.text, /Всё нужное для отправки есть/);
  assert.match(ans.text, /«Отправить»/);
  const [use] = await S.sql`select purpose, ok from ai_usage where user_id = ${owner.user.id} order by id desc limit 1`;
  assert.deepEqual(use, { purpose: 'mail', ok: true }, 'разбор письма — в дневном лимите');

  // Ответ «Отправить» — заявка уходит в подбор от имени заказчика; диспетчер получает уведомление.
  const s = await letter({ from: OWNER_MAIL, subject: `Re: ${ans.subject}`, text: 'Отправить\n\n> старое письмо', in_reply_to: [ans.messageId] });
  assert.equal(s.inbound.outcome, 'submitted');
  const after = (await owner.req('GET', `/api/orders/${id}`)).body;
  assert.equal(after.order.status, 'matching');
  assert.equal(after.history.at(-1).side, 'customer');
  assert.match(lastSent().text, /Заявка отправлена/);
  assert.equal(lastSent().inReplyTo, s.message_id);
  const [n] = await S.sql`select count(*)::int as n from notifications where user_id = ${dispatcher.user.id} and event = 'submitted' and order_id = ${id}`;
  assert.equal(n.n, 1);
});

test('не хватает данных: ответ перечисляет, чего нет; дописанное в ответе дополняет, «Отправить» срабатывает, когда всего хватает', async () => {
  const r = await letter({ from: OWNER_MAIL, subject: 'Квартира', text: 'Нужна оценка квартиры для суда.\nОпределение суда № 2-77/2026 от 01.09.2026 во вложении.',
    attachments: [file('определение суда.txt', 'тестовое определение')] });
  assert.equal(r.inbound.outcome, 'created');
  const id = r.inbound.order_id;
  let o = (await owner.req('GET', `/api/orders/${id}`)).body.order;
  assert.equal(o.basis_kind, 'court');
  assert.equal(o.basis_number, '2-77/2026');
  assert.equal(o.basis_date, '2026-09-01');
  const docs = (await owner.req('GET', `/api/orders/${id}/documents`)).body.documents;
  assert.equal(docs[0].kind, 'basis', 'файл определения — основание');
  const ans = lastSent();
  assert.match(ans.text, /не хватает: .*Где находится объект.*срок/);

  const half = await letter({ from: OWNER_MAIL, text: `Отправить\nОбъект в Подмосковье. Адрес: Московская обл., тестовый пос., 3. Срок до ${ru(deadline())}`, in_reply_to: [ans.messageId] });
  assert.equal(half.inbound.outcome, 'submitted', JSON.stringify(half));
  o = (await owner.req('GET', `/api/orders/${id}`)).body.order;
  assert.equal(o.status, 'matching');
  assert.equal(o.fields.region, 'mo');
  assert.equal(o.deadline, deadline());
  assert.equal(o.fields.purpose, 'court', 'заполненное не меняется');
});

test('«Отправить» без нужного — заявка остаётся черновиком, ответ говорит, чего не хватает', async () => {
  const r = await letter({ from: OWNER_MAIL, subject: 'Машина', text: 'Оценить автомобиль' });
  const ans = lastSent();
  const s = await letter({ from: OWNER_MAIL, text: 'Отправить', in_reply_to: [ans.messageId] });
  assert.equal(s.inbound.outcome, 'updated');
  assert.equal((await owner.req('GET', `/api/orders/${r.inbound.order_id}`)).body.order.status, 'new');
  assert.match(lastSent().text, /пока нельзя отправить.*\n[\s\S]*не хватает:/);
});

test('не понятно, какая услуга — заявка не создаётся, ответ с перечнем услуг; вложения не сохраняются', async () => {
  const before = (await S.sql`select count(*)::int as n from orders`)[0].n;
  const r = await letter({ from: OWNER_MAIL, subject: 'Вопрос', text: 'Здравствуйте, у меня вопрос про отпуск', attachments: [file('x.txt', 'x')] });
  assert.equal(r.inbound.outcome, 'no_service');
  assert.equal((await S.sql`select count(*)::int as n from orders`)[0].n, before);
  assert.match(lastSent().text, /Оценка недвижимости/);
  assert.equal(lastSent().to, OWNER_MAIL);
});

// ——— Кто может прислать ———

test('неподключённый адрес — заявки нет, один ответ-подсказка в сутки; поддельный отправитель и автоответ — без ответа', async () => {
  const before = (await S.sql`select count(*)::int as n from orders`)[0].n;
  const a = await letter({ ...flatLetter(), from: 'stranger-test@example.ru' });
  assert.equal(a.inbound.outcome, 'unknown_sender');
  assert.equal(sent().length, 1);
  assert.match(lastSent().text, /не подключён/);
  await letter({ ...flatLetter(), from: 'stranger-test@example.ru' });
  assert.equal(sent().length, 1, 'второй раз за сутки — без ответа');

  const fake = await letter({ ...flatLetter(), authenticated: false });
  assert.equal(fake.inbound.outcome, 'not_authenticated', 'подлинность не подтверждена — адрес мог быть подделан');
  const auto = await letter({ ...flatLetter(), auto_reply: true });
  assert.equal(auto.inbound.outcome, 'auto_reply');
  assert.equal(sent().length, 1);
  assert.equal((await S.sql`select count(*)::int as n from orders`)[0].n, before);
  const [row] = await S.sql`select body from mail_inbound where id = ${a.inbound.id}`;
  assert.equal(row.body, '', 'текст писем непринятых отправителей не хранится');
});

test('ответ в чужую переписку не принимается: другой человек не дополняет и не отправляет чужую заявку', async () => {
  const r = await letter(flatLetter());
  const ans = lastSent();
  await connect(other, 'other2-test@example.ru');
  const x = await letter({ from: 'other2-test@example.ru', text: 'Отправить', in_reply_to: [ans.messageId] });
  assert.equal(x.inbound.outcome, 'no_access');
  assert.equal((await owner.req('GET', `/api/orders/${r.inbound.order_id}`)).body.order.status, 'new');
  assert.equal(lastSent().to, 'other2-test@example.ru');
  assert.doesNotMatch(lastSent().text, new RegExp(r.inbound.order_id.slice(0, 8), 'i'), 'номер чужой заявки не раскрывается');
});

test('от имени организации: заявка — дело организации; ушёл из организации — письма не принимаются', async () => {
  await connect(member, 'member-test@example.ru');
  assert.equal((await member.req('PATCH', '/api/me/mail', { org_id: org.id })).status, 200);
  const r = await letter({ ...flatLetter(), from: 'member-test@example.ru' });
  assert.equal(r.inbound.outcome, 'created');
  const o = (await head.req('GET', `/api/orders/${r.inbound.order_id}`)).body;
  assert.equal(o.order.org_id, org.id, 'руководитель видит дело сотрудника');
  assert.equal(o.mail.email, 'member-test@example.ru');

  await S.sql`delete from org_members where org_id = ${org.id} and user_id = ${member.user.id}`;
  const x = await letter({ ...flatLetter(), from: 'member-test@example.ru' });
  assert.equal(x.inbound.outcome, 'no_access');
  assert.match(lastSent().text, /больше не состоите/);
  assert.equal((await member.req('GET', '/api/me/mail')).body.address.org_lost, true);
  await addMember(S.sql, org.id, member.user.id, 'member');
});

// ——— Ход заявки и результат ———

test('ход заявки по письму: цена, оплата, принятие — письмами; ответ на письмо в работе — сообщение в переписке; результат во вложении', async () => {
  const r = await letter(flatLetter());
  const id = r.inbound.order_id;
  await letter({ from: OWNER_MAIL, text: 'Отправить', in_reply_to: [lastSent().messageId] });

  // Цена → письмо «оплатите».
  assert.equal((await dispatcher.req('PUT', `/api/orders/${id}/price`, { price: '15000' })).status, 200);
  assert.match(lastSent().text, /Цена заявки — 15[\s ]000,00 ₽/);
  // Оплата (поддельная ЮKassa) → письмо «оплата получена».
  const pay = await owner.req('POST', `/api/orders/${id}/payments`);
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal((await owner.req('POST', `/api/orders/${id}/payments/refresh`)).status, 200);
  assert.match(lastSent().text, /Оплата получена/);
  assert.equal((await dispatcher.req('POST', `/api/orders/${id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  assert.match(lastSent().text, /Исполнитель принял заявку/);

  // Ответ на письмо, пока заявка в работе, — сообщение заказчика в переписке по заявке.
  const m = await letter({ from: OWNER_MAIL, text: 'Ключи у консьержа\n\n> старое', in_reply_to: [lastSent().messageId] });
  assert.equal(m.inbound.outcome, 'message');
  const chat = (await spec.req('GET', `/api/orders/${id}/messages`)).body.messages;
  assert.deepEqual(chat.map((x) => [x.side, x.body]), [['customer', 'Ключи у консьержа']]);

  // Сдача, проверка, «готово» — результат уходит во вложении.
  await spec.req('POST', `/api/orders/${id}/results`, Buffer.from('Тестовое заключение: 100 руб.'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') } });
  await signResults(S, spec, id);
  assert.equal((await spec.req('POST', `/api/orders/${id}/status`, { from: 'in_work', to: 'review' })).status, 200);
  const { checks, round } = (await dispatcher.req('GET', `/api/orders/${id}/review`)).body;
  for (const c of checks) assert.equal((await dispatcher.req('PUT', `/api/orders/${id}/review/${c.id}`, { verdict: 'ok', round })).status, 200);
  S.providers.mail.calls.length = 0;
  const dn = await dispatcher.req('POST', `/api/orders/${id}/status`, { from: 'review', to: 'done' });
  assert.equal(dn.status, 200, JSON.stringify(dn.body));
  const done = sent().find((x) => /Результат проверен/.test(x.text));
  assert.ok(done, 'письмо с результатом');
  assert.equal(done.to, OWNER_MAIL);
  assert.deepEqual(done.attachments.map((a) => a.filename), ['заключение.txt', 'заключение.txt.sig'], 'подпись УКЭП — рядом с файлом (2.5)');
  assert.match(done.subject, /Заявка №/);

  // Закрытая заявка: письма по ней больше не принимаются.
  assert.equal((await owner.req('POST', `/api/orders/${id}/status`, { from: 'done', to: 'closed' })).status, 200);
  const late = await letter({ from: OWNER_MAIL, text: 'Ещё вопрос', in_reply_to: [done.messageId] });
  assert.equal(late.inbound.outcome, 'no_access');
  assert.match(lastSent().text, /завершена/);
});

test('отключил адрес или дело передано коллеге — письма по заявке больше не уходят', async () => {
  await connect(member, 'member-test@example.ru');
  await S.sql`update mail_addresses set org_id = ${org.id} where user_id = ${member.user.id}`;
  const r = await letter({ ...flatLetter(), from: 'member-test@example.ru' });
  const id = r.inbound.order_id;
  assert.equal((await head.req('PATCH', `/api/orders/${id}/responsible`, { user_id: head.user.id })).status, 200);
  await S.sql`update orders set deadline = ${deadline()} where id = ${id}`;
  assert.equal((await head.req('POST', `/api/orders/${id}/status`, { from: 'new', to: 'matching' })).status, 200);
  S.providers.mail.calls.length = 0;
  assert.equal((await dispatcher.req('PUT', `/api/orders/${id}/price`, { price: '9000' })).status, 200);
  assert.equal(sent().length, 0, 'ведёт уже не тот, чей адрес');
  // Ответ бывшего ответственного в переписку — не принимается.
  const x = await letter({ from: 'member-test@example.ru', text: 'Отправить', in_reply_to: [r.message_id] });
  assert.equal(x.inbound.outcome, 'no_access');
});

test('ИИ недоступен — письмо ждёт повтора; после всех попыток — ответ «не получилось»', async () => {
  S.providers.ai.script({ kind: 'fail', message: 'тест' });
  try {
    const r = await letter(flatLetter());
    assert.equal(r.inbound.status, 'pending');
    assert.equal(sent().length, 0);
    await S.sql`update mail_inbound set attempts = 5, next_at = now() where id = ${r.inbound.id}`;
    const { processInbound } = await import('../../src/mail/inbound.mjs');
    const { deliverMail } = await import('../../src/mail/outbox.mjs');
    await processInbound({ sql: S.sql, providers: S.providers, cfg: S.cfg, registry: S.app.locals.registry });
    await deliverMail(S.sql, S.providers, S.cfg);
    const [row] = await S.sql`select outcome from mail_inbound where id = ${r.inbound.id}`;
    assert.equal(row.outcome, 'failed');
    assert.match(lastSent().text, /Не получилось разобрать письмо/);
  } finally { S.providers.ai.script(null); }
});

test('письмо не ушло — повтор позже; само действие от этого не страдает', async () => {
  S.providers.mail.script({ kind: 'fail', message: 'тест' });
  let r;
  try { r = await letter(flatLetter()); } finally { S.providers.mail.script(null); }
  assert.equal(r.inbound.outcome, 'created');
  const [m] = await S.sql`select status, attempts, error from mail_outbox where order_id = ${r.inbound.order_id}`;
  assert.deepEqual([m.status, m.attempts], ['pending', 1]);
  await S.sql`update mail_outbox set next_at = now() where order_id = ${r.inbound.order_id}`;
  const { deliverMail } = await import('../../src/mail/outbox.mjs');
  assert.equal((await deliverMail(S.sql, S.providers, S.cfg)).sent, 1);
});
