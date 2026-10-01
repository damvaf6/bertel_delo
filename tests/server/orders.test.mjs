// Единая «Заявка» (задача 1.3): описание модуля как данные, поля заявки, срок, основание, статусы и история.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePrice } from '../helpers.mjs';
import { DEFAULT_MODULES, createRegistry, validateModule } from '../../src/modules/index.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import expertise from '../../src/modules/expertise.mjs';

// Вторая «профессия» только описанием — ядро не меняется (устав, раздел 1а: новая профессия = три описания).
const TRANSLATION = {
  id: 'translation',
  name: 'Перевод (проверочный модуль)',
  basis: ['contract'],
  fields: [{ id: 'notary', label: 'Нужно нотариальное заверение', type: 'select', required: true, options: [{ id: 'yes', name: 'Да' }, { id: 'no', name: 'Нет' }] }],
  services: [{ id: 'written', name: 'Письменный перевод', fields: [{ id: 'pages', label: 'Страниц', type: 'number', integer: true, min: 1, max: 1000, required: true }] }],
  checks: [{ id: 'completeness', title: 'Переведено всё' }],
};

let S, owner, dispatcher, admin, stranger, spec;
const today = todayMsk();
const soon = addDays(today, 10);
const READY = { deadline: soon, fields: { purpose: 'court', region: 'mo', object_type: 'flat', address: 'Московская обл., тестовый пос., д. 1' } };

before(async () => {
  S = await startApp({}, { modules: [...DEFAULT_MODULES, TRANSLATION] });
  owner = await login(S, '+79990000301');
  dispatcher = await login(S, '+79990000302');
  admin = await login(S, '+79990000303');
  stranger = await login(S, '+79990000304');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  spec = await login(S, '+79990000305');
  await makeSpecialist(S.sql, spec.user.id, { capacity: 50 });
});
after(async () => { await S?.close(); });

const create = async (c, body = {}) => {
  const r = await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.order;
};
// Диспетчер предлагает дело специалисту (шаг «подбор → ждёт исполнителя»).
async function offer(o, who = spec, from) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  await ensurePrice(S.sql, o.id);
  return dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: from ?? cur.status });
}
const patch = (c, o, body) => c.req('PATCH', `/api/orders/${o.id}`, body);
// Шаг от статуса, который сейчас в базе (как будто человек только что открыл заявку); from можно задать явно.
async function step(c, o, to, reason, from) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, reason, from: from ?? cur.status });
}
const upload = (c, o, kind = 'other', name = 'файл.pdf') => c.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('тестовое определение'), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': kind },
});
// Исполнитель прикладывает результат; диспетчер отмечает все правила проверки «в порядке» (задача 1.5).
const putResult = (o) => spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('тестовый отчёт'), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('отчёт.pdf') },
});
async function passReview(o) {
  const r = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of r.checks) assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: r.round })).status, 200);
}
async function ready(c = owner, extra = {}) {
  const o = await create(c, extra);
  const r = await patch(c, o, READY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return o;
}

test('описание модуля «Экспертиза» проходит проверку формата; пять видов оценки из устава', () => {
  validateModule(expertise);
  const reg = createRegistry();
  const [m] = reg.catalog();
  assert.equal(m.id, 'expertise');
  assert.deepEqual(m.services.map((s) => s.name), [
    'Оценка недвижимости', 'Оценка земельного участка', 'Оценка транспортного средства', 'Оценка движимого имущества', 'Товароведческая экспертиза',
  ]);
  assert.deepEqual(m.basis.map((b) => b.id), ['contract', 'court']);
  // У каждой услуги — общие поля модуля и свои; у каждой есть ИИ-проверки.
  for (const s of m.services) {
    assert.deepEqual(s.fields.slice(0, 3).map((f) => f.id), ['purpose', 'region', 'comment']);
    assert.ok(s.fields.length > 3, s.id);
    assert.ok(m.checks.some((c) => c.services.includes(s.id)), s.id);
  }
  assert.ok(Object.isFrozen(reg.modules[0].services[0]), 'описание в работе не меняется');
});

test('ошибка в описании модуля — приложение не соберётся (ошибка сразу, а не у пользователя)', () => {
  const clone = () => structuredClone(expertise);
  const broken = [
    ['неизвестный тип поля', (m) => { m.services[0].fields[1].type = 'photo'; }],
    ['id услуги повторяется', (m) => { m.services[1].id = 'realty'; }],
    ['выбор без вариантов', (m) => { m.fields[0].options = []; }],
    ['шаблон без подсказки', (m) => { delete m.services[0].fields[2].hint; }],
    ['неверный шаблон', (m) => { m.services[0].fields[2].pattern = '(['; }],
    ['лишний ключ (опечатка)', (m) => { m.services[0].fields[1].requird = true; }],
    ['проверка для чужой услуги', (m) => { m.checks[3].services = ['realty', 'nope']; }],
    ['неизвестное основание', (m) => { m.basis = ['contract', 'order']; }],
    ['поле услуги совпадает с общим', (m) => { m.services[0].fields[0].id = 'region'; }],
    ['нет ИИ-проверок', (m) => { m.checks = []; }],
    ['min больше max', (m) => { m.services[0].fields[3].min = 10; m.services[0].fields[3].max = 1; }],
    ['пустое название', (m) => { m.name = ' '; }],
  ];
  for (const [what, spoil] of broken) {
    const m = clone();
    spoil(m);
    assert.throws(() => validateModule(m), /Описание модуля/, what);
  }
  assert.throws(() => createRegistry([expertise, expertise]), /объявлен дважды/);
  validateModule(TRANSLATION);
});

test('новая профессия — только описанием: заявка создаётся, заполняется и отправляется без правок ядра', async () => {
  const cat = (await owner.req('GET', '/api/catalog')).body.modules;
  assert.deepEqual(cat.map((m) => m.id), ['expertise', 'translation']);
  const o = await create(owner, { module: 'translation', service: 'written' });
  assert.equal(o.title, 'Письменный перевод', 'название по умолчанию — название услуги');
  assert.equal(o.basis_kind, 'contract');
  assert.equal((await patch(owner, o, { deadline: soon, fields: { notary: 'yes', pages: '12' } })).status, 200);
  const r = await step(owner, o, 'matching');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.module_name, 'Перевод (проверочный модуль)');
  assert.deepEqual(r.body.order.fields, { notary: 'yes', pages: 12 });
  assert.equal((await patch(owner, await create(owner, { module: 'translation', service: 'written' }), { basis_kind: 'court' })).status, 400,
    'основание, которого нет в описании модуля, не выбрать');
});

test('создание: услуга обязательна и только из описания', async () => {
  for (const body of [{ module: 'expertise', service: 'nope' }, { module: 'nope', service: 'realty' }, { module: 'expertise' }, {}]) {
    assert.equal((await owner.req('POST', '/api/orders', { title: 'x', ...body })).status, 400, JSON.stringify(body));
  }
  const o = await create(owner, { title: '  Оценка квартиры для суда  ' });
  assert.equal(o.title, 'Оценка квартиры для суда');
  assert.equal(o.status, 'new');
  assert.equal(o.status_name, 'Новая');
  assert.equal(o.service_name, 'Оценка недвижимости');
  assert.equal(o.basis_kind, 'contract', 'основание по умолчанию — договор');
});

test('поля заявки: только из описания, типы и ограничения соблюдаются', async () => {
  const o = await create(owner);
  const bad = async (fields, re) => {
    const r = await patch(owner, o, { fields });
    assert.equal(r.status, 400, JSON.stringify(fields));
    if (re) assert.match(r.body.message, re);
  };
  await bad({ secret: 'x' }, /лишнее поле/);
  await bad({ vin: 'X' }, /лишнее поле/);                      // поле другой услуги
  await bad({ object_type: 'castle' }, /выберите из списка/);
  await bad({ area: 'много' }, /нужно число/);
  await bad({ area: 0 }, /не меньше 1/);
  await bad({ cadastral: '123' }, /77:01:0001001:1234/);
  await bad({ address: 'а'.repeat(301) }, /не длиннее 300/);
  await bad({ address: 12 }, /нужен текст/);
  await bad([], /неверный формат/);

  const r = await patch(owner, o, { fields: { purpose: 'bank', region: 'moscow', address: '  г. Москва, тестовая ул., 2  ', area: '54,3', cadastral: '77:01:0001001:1234', comment: '' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.order.fields, { purpose: 'bank', region: 'moscow', address: 'г. Москва, тестовая ул., 2', area: 54.3, cadastral: '77:01:0001001:1234' });

  // Смена услуги: поля, которых у новой услуги нет, отбрасываются; общие остаются.
  const v = await patch(owner, o, { service: 'vehicle' });
  assert.equal(v.status, 200);
  assert.equal(v.body.order.service_name, 'Оценка транспортного средства');
  assert.deepEqual(v.body.order.fields, { purpose: 'bank', region: 'moscow' });
  const vin = await patch(owner, o, { fields: { vin: 'xta21099012345678', year: 2015 } });
  assert.equal(vin.body.order.fields.vin, 'XTA21099012345678', 'VIN — заглавными');
  assert.equal((await patch(owner, o, { fields: { year: 2015.5 } })).status, 400);
  assert.equal((await patch(owner, o, { fields: { vin: 'XTA2109901234567O' } })).status, 400, 'буква O в VIN недопустима');
  assert.equal((await patch(owner, o, { service: 'nope' })).status, 400);
});

test('срок: дата, не в прошлом, не дальше двух лет; даты не «съезжают»', async () => {
  const o = await create(owner);
  for (const d of ['2026-02-30', 'завтра', '01.10.2026', addDays(today, -1), addDays(today, 800)]) {
    assert.equal((await patch(owner, o, { deadline: d })).status, 400, d);
  }
  const r = await patch(owner, o, { deadline: today });
  assert.equal(r.status, 200);
  assert.equal(r.body.order.deadline, today);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.order.deadline, today);
  assert.equal((await patch(owner, o, { deadline: null })).body.order.deadline, null);
});

test('сегодняшний день считается по Москве', () => {
  assert.equal(todayMsk(new Date('2026-09-30T20:59:00Z')), '2026-09-30');
  assert.equal(todayMsk(new Date('2026-09-30T21:00:00Z')), '2026-10-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('отправка: без обязательных полей и срока — нельзя, с понятным списком', async () => {
  const o = await create(owner);
  const r = await step(owner, o, 'matching');
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Не хватает: Для чего нужна оценка, Где находится объект, Что оцениваем, Адрес объекта, срок/);
  assert.equal((await patch(owner, o, READY)).status, 200);
  const ok = await step(owner, o, 'matching');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.status_name, 'Подбор исполнителя');
  assert.ok(ok.body.order.submitted_at);
});

test('основание «определение суда»: номер, дата и файл обязательны; файл основания после отправки не удалить', async () => {
  const o = await ready();
  assert.equal((await patch(owner, o, { basis_kind: 'court', basis_date: addDays(today, 1) })).status, 400, 'дата определения в будущем');
  const c = await patch(owner, o, { basis_kind: 'court' });
  assert.equal(c.body.order.basis_name, 'Определение суда');
  let r = await step(owner, o, 'matching');
  assert.equal(r.status, 400);
  assert.match(r.body.message, /номер определения, дата определения, файл определения суда/);

  assert.equal((await patch(owner, o, { basis_number: '2-1234/2026', basis_date: '2026-09-15' })).status, 200);
  const other = (await upload(owner, o, 'other', 'фото.jpg')).body.document;
  r = await step(owner, o, 'matching');
  assert.match(r.body.message, /файл определения суда/, 'прочий файл основанием не считается');
  assert.equal((await upload(owner, o, 'contract')).status, 400, 'неизвестный вид документа');
  const basis = (await upload(owner, o, 'basis', 'определение.pdf')).body.document;
  assert.equal(basis.kind, 'basis');
  r = await step(owner, o, 'matching');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.basis_number, '2-1234/2026');
  assert.equal(r.body.order.basis_date, '2026-09-15');

  assert.equal((await owner.req('DELETE', `/api/documents/${basis.id}`)).status, 409);
  assert.equal((await owner.req('DELETE', `/api/documents/${other.id}`)).status, 204, 'прочие файлы — можно');

  // Возврат к договору стирает реквизиты определения.
  const o2 = await ready();
  await patch(owner, o2, { basis_kind: 'court', basis_number: '1', basis_date: '2026-09-01' });
  const back = await patch(owner, o2, { basis_kind: 'contract' });
  assert.equal(back.body.order.basis_number, null);
  assert.equal(back.body.order.basis_date, null);
});

test('отправленную заявку заказчик не правит', async () => {
  const o = await ready();
  assert.equal((await step(owner, o, 'matching')).status, 200);
  const r = await patch(owner, o, { title: 'Правка после отправки' });
  assert.equal(r.status, 409);
  const got = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.equal(got.editable, false);
  assert.notEqual(got.order.title, 'Правка после отправки');
});

test('весь путь: новая → подбор → ждёт исполнителя → в работе → проверка → готово → закрыто; история видна заказчику', async () => {
  const o = await ready();
  let g = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.deepEqual(g.actions.map((a) => a.to), ['matching', 'cancelled']);
  assert.equal(g.editable, true);

  assert.equal((await step(owner, o, 'matching')).status, 200);
  g = (await dispatcher.req('GET', `/api/orders/${o.id}`)).body;
  assert.deepEqual(g.actions.map((a) => a.to), ['cancelled'], 'предложить дело — отдельной операцией подбора, не шагом статуса');
  assert.equal(g.editable, false);
  assert.equal((await step(dispatcher, o, 'awaiting_executor')).status, 409);

  assert.equal((await offer(o)).status, 200);
  assert.deepEqual((await dispatcher.req('GET', `/api/orders/${o.id}`)).body.actions.map((a) => a.to), ['matching', 'cancelled']);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.actions.map((a) => a.to), ['in_work', 'matching']);
  assert.equal((await step(spec, o, 'matching')).status, 400, 'отказ — с причиной');
  assert.equal((await step(spec, o, 'matching', 'Занят до конца месяца')).status, 200);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}`)).status, 404, 'после отказа дело исполнителю не видно');
  assert.equal((await offer(o)).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  assert.equal((await step(owner, o, 'cancelled')).status, 403, 'после начала работ заказчик сам не отменяет');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.actions, []);
  assert.equal((await step(spec, o, 'done')).status, 409, 'через проверку не перепрыгнуть');
  assert.equal((await step(dispatcher, o, 'review')).status, 403, 'сдаёт исполнитель, не диспетчер');
  assert.equal((await step(spec, o, 'review')).status, 400, 'без файла результата не сдать');
  assert.equal((await putResult(o)).status, 201);
  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.equal((await step(dispatcher, o, 'in_work', 'Нет расчёта аналогов')).status, 200);
  assert.equal((await step(spec, o, 'review')).status, 200);
  assert.equal((await step(dispatcher, o, 'done')).status, 409, 'не все правила проверены');
  await passReview(o);
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
  assert.equal((await step(owner, o, 'closed')).status, 409, 'неоплаченную не закрыть (1.6)');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  assert.equal((await step(owner, o, 'closed')).status, 200, 'заказчик принимает результат');
  assert.equal((await step(dispatcher, o, 'cancelled', 'поздно')).status, 409);
  assert.equal((await step(owner, o, 'nope')).status, 400);

  g = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.equal(g.order.status_name, 'Закрыта');
  assert.deepEqual(g.history.map((h) => [h.to_status, h.side]), [
    ['new', 'customer'], ['matching', 'customer'], ['awaiting_executor', 'dispatcher'], ['matching', 'executor'],
    ['awaiting_executor', 'dispatcher'], ['in_work', 'executor'], ['review', 'executor'], ['in_work', 'dispatcher'],
    ['review', 'executor'], ['done', 'dispatcher'], ['closed', 'customer'],
  ]);
  assert.equal(g.history[3].reason, 'Занят до конца месяца');
  assert.equal(g.history[7].from_name, 'Проверка результата');
  assert.equal(g.history[0].actor_id, undefined, 'кто именно из диспетчеров — наружу не отдаётся');

  // Завершённая заявка: файлы не добавляются и не удаляются.
  assert.equal((await upload(owner, o)).status, 409);
  const [{ n }] = await S.sql`select count(*)::int as n from audit_log where subject_id = ${o.id} and action = 'order.status'`;
  assert.equal(n, 8);
});

test('отмена: заказчик — до начала работ, без причины; диспетчер — с причиной; «новую» диспетчер не трогает', async () => {
  const a = await create(owner);
  assert.equal((await step(dispatcher, a, 'cancelled', 'дубль')).status, 403, 'новую (неотправленную) отменяет только заказчик');
  assert.equal((await step(owner, a, 'cancelled')).status, 200);
  assert.equal((await patch(owner, a, { title: 'x' })).status, 409);

  const b = await ready();
  await step(owner, b, 'matching');
  await offer(b);
  assert.equal((await step(owner, b, 'cancelled')).status, 200, 'ждёт исполнителя — ещё можно');
  const [bo] = await S.sql`select executor_user_id, (select outcome from order_offers where order_id = ${b.id}) as outcome from orders where id = ${b.id}`;
  assert.equal(bo.executor_user_id, null, 'у отменённой заявки исполнителя нет');
  assert.equal(bo.outcome, 'withdrawn');

  const c = await ready();
  await step(owner, c, 'matching');
  await offer(c);
  await step(spec, c, 'in_work');
  assert.equal((await step(dispatcher, c, 'cancelled')).status, 400, 'без причины');
  const r = await step(dispatcher, c, 'cancelled', 'Заказчик попросил по телефону');
  assert.equal(r.status, 200);
  assert.equal(r.body.order.status_name, 'Отменена');
  assert.equal((await step(admin, c, 'matching')).status, 409);
});

test('два одновременных шага по одной заявке: проходит только один', async () => {
  const o = await ready();
  await step(owner, o, 'matching');
  // Оба видели «подбор»: один предлагает исполнителю, другой отменяет. Отмена не должна сработать для нового этапа.
  const [a, b] = await Promise.all([
    offer(o, spec, 'matching'),
    step(dispatcher, o, 'cancelled', 'одновременно', 'matching'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const log = await S.sql`select count(*)::int as n from order_status_history where order_id = ${o.id}`;
  assert.equal(log[0].n, 3);
  const late = await step(dispatcher, o, 'in_work', null, 'matching');
  assert.equal(late.status, 409, 'шаг от устаревшего статуса');
  assert.match(late.body.message, /уже изменился/);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work' })).status, 400, 'без статуса «откуда» — нельзя');
});

test('просрочка: видна в списке, пока заявка не готова', async () => {
  const o = await ready();
  await step(owner, o, 'matching');
  await S.sql`update orders set deadline = ${addDays(today, -3)} where id = ${o.id}`;
  const row = async (c) => (await c.req('GET', '/api/orders')).body.orders.find((x) => x.id === o.id);
  assert.equal((await row(owner)).overdue, true);
  assert.equal((await row(dispatcher)).overdue, true);
  await S.sql`update orders set status = 'done' where id = ${o.id}`;
  assert.equal((await row(owner)).overdue, false);
  assert.equal(await row(stranger), undefined);
});

test('заявка-заготовка без услуги (из каркаса) не отправится, пока услугу не выберут', async () => {
  const [o] = await S.sql`insert into orders (owner_user_id, title) values (${owner.user.id}, 'Заготовка') returning *`;
  const r = await step(owner, o, 'matching');
  assert.equal(r.status, 400);
  assert.match(r.body.message, /услуга/);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.order.service_name, null);
  assert.equal((await patch(owner, o, { ...READY, module: 'expertise', service: 'realty' })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  // Отправленная заявка без услуги или срока невозможна и на уровне базы.
  await assert.rejects(S.sql`update orders set deadline = null where id = ${o.id}`, /orders_submitted_ready/);
});
