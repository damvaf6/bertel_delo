// Демо-площадка для показа (задача 2.51): наполняет проверочную площадку обезличенными делами по всем видам экспертизы
// и оценки — разные статусы, две организации экспертов, частный эксперт, частные заказчики, юрфирма и банк.
// Всё делается обычными операциями платформы через служебный вход (как живые люди нажимали бы кнопки), без записи в базу
// напрямую: права, деньги, подписи и уведомления — настоящие правила ядра. Никаких настоящих людей и организаций:
// номера +7 999 000-10-xx, имена и организации вымышленные (в названиях организаций — «демо»).
// Повторный запуск ничего не дублирует: если у демо-заказчика уже есть заявки, площадка считается наполненной.
//   seedDemo({ base, headers, login, adminPhone }) — из проверок (tests/server/demo.test.mjs, экскурсия tests/tools/demo-tour.mjs)
// и при ночном сбросе открытой демо-площадки (src/demo/demo.mjs; решение Дамира 05.10.2026, вопрос 21, вариант Б).
import { makePdf, makeDocx } from './make-docs.mjs';

const tel = (n) => `+79990001${String(n).padStart(3, '0')}`;

// Люди демо-площадки. role: dispatcher | expert | head | customer; org — ключ организации.
export const DEMO_PEOPLE = {
  dispatcher: { phone: tel(1), name: 'Смирнова Ольга Викторовна', role: 'dispatcher' },
  headA: { phone: tel(10), name: 'Ковалёва Марина Игоревна', org: 'A' },
  orlov: { phone: tel(11), name: 'Орлов Дмитрий Сергеевич', org: 'A', permits: ['realty', 'land'] },
  belova: { phone: tel(12), name: 'Белова Наталья Андреевна', org: 'A', permits: ['vehicle', 'movable'] },
  grishin: { phone: tel(13), name: 'Гришин Павел Олегович', org: 'A', permits: ['construction'] },
  headB: { phone: tel(20), name: 'Лебедев Игорь Викторович', org: 'B' },
  zakharova: { phone: tel(21), name: 'Захарова Елена Павловна', org: 'B', permits: ['goods', 'handwriting'] },
  tikhonov: { phone: tel(22), name: 'Тихонов Артём Николаевич', org: 'B', permits: ['realty', 'vehicle'] },
  morozova: { phone: tel(30), name: 'Морозова Светлана Юрьевна', permits: ['realty', 'land', 'movable'] },
  petrov: { phone: tel(40), name: 'Петров Алексей Викторович' },
  sidorova: { phone: tel(41), name: 'Сидорова Ирина Михайловна' },
  headLaw: { phone: tel(50), name: 'Новиков Константин Андреевич', org: 'LAW' },
  lawyer: { phone: tel(51), name: 'Фёдорова Анна Сергеевна', org: 'LAW' },
  headBank: { phone: tel(60), name: 'Воронцова Татьяна Олеговна', org: 'BANK' },
  banker: { phone: tel(61), name: 'Ершов Михаил Ильич', org: 'BANK' },
};

export const DEMO_ORGS = {
  A: { name: 'Центр оценки «Пример» (демо)', head: 'headA', inn: '7700000001' },
  B: { name: 'Бюро судебных экспертиз «Образец» (демо)', head: 'headB', inn: '7700000002' },
  LAW: { name: 'Юридическая фирма «Право и дело» (демо)', head: 'headLaw', inn: '7700000003' },
  BANK: { name: 'Банк «Демо-кредит» (демо)', head: 'headBank', inn: '7700000004' },
};

const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

// Дела демо-площадки. stage — до какого шага довести: new | priced | paid | offered | org_offered | in_work | review | done | closed | cancelled.
export const DEMO_CASES = [
  {
    key: 'flat', who: 'petrov', service: 'realty', stage: 'closed', expert: 'orlov', price: 9000, days: 7,
    title: 'Оценка квартиры для нотариуса (наследство)',
    fields: { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Примерная, д. 5, кв. 12', cadastral: '77:01:0001001:1234', area: 54.3, floor: '5 / 9', rooms: 2, year_built: 1978 },
    docs: [['Выписка ЕГРН.pdf', ['Выписка из ЕГРН (образец)', 'Квартира, 54,3 кв. м, г. Москва, ул. Примерная, д. 5, кв. 12']]],
    report: 'Отчёт об оценке квартиры.pdf', value: '11 850 000',
    chat: [['petrov', 'Добрый день! Нотариус просит отчёт на дату смерти — 14.08.2026.'], ['orlov', 'Принято, оценку делаю на 14.08.2026. Осмотр — по фото из квартиры.']],
  },
  {
    key: 'car_court', who: 'lawyer', org: 'LAW', service: 'vehicle', stage: 'review', expert: 'belova', price: 15000, days: 5,
    title: 'Оценка автомобиля для суда (раздел имущества)',
    fields: { purpose: 'court', region: 'moscow', vehicle_type: 'car', make_model: 'Демомобиль Седан (вымышленный)', year: 2021, vin: 'XTA000000M0000021', reg_number: 'А000АА777', mileage: 48000 },
    docs: [['Определение суда о назначении экспертизы.pdf', ['Определение (образец)', 'Назначить оценку автомобиля Демомобиль Седан 2021 г.в.']], ['СТС.pdf', ['СТС (образец): Демомобиль Седан, 2021, VIN XTA000000M0000021']]],
    report: 'Заключение об оценке автомобиля.pdf', value: '1 420 000',
    chat: [['lawyer', 'Судебное заседание 20-го числа, просим успеть за неделю.'], ['belova', 'Успеем. Фото машины получила, VIN совпадает со СТС.']],
  },
  {
    key: 'land', who: 'sidorova', service: 'land', stage: 'in_work', expert: 'morozova', price: 12000, days: 2,
    title: 'Оценка участка ИЖС для раздела имущества',
    fields: { purpose: 'division', region: 'mo', address: 'Московская обл., Одинцовский г. о., д. Примерово, уч. 7', cadastral: '50:20:0010203:456', area: 1200, land_use: 'izhs', land_category: 'settlement', buildings: 'Баня 20 кв. м' },
    docs: [['Выписка ЕГРН на участок.pdf', ['Выписка из ЕГРН (образец)', 'Участок 1200 кв. м, ИЖС, д. Примерово']]],
    chat: [['morozova', 'Ирина Михайловна, пришлите, пожалуйста, фото подъезда к участку и бани.'], ['sidorova', 'Хорошо, завтра съезжу и сфотографирую.']],
  },
  {
    key: 'repair', who: 'lawyer', org: 'LAW', service: 'construction', stage: 'org_offered', orgExec: 'A', price: 45000, days: 21,
    title: 'Строительная экспертиза: недостатки ремонта квартиры',
    fields: { purpose: 'court', region: 'moscow', object_kind: 'flat', task: 'defects', address: 'г. Москва, Демонстрационный пр-д, д. 3, кв. 40', questions: '1. Есть ли недостатки отделочных работ по договору подряда?\n2. Какова стоимость их устранения?', docs: 'Договор подряда, смета, акт приёмки', area: 68 },
    docs: [['Договор подряда.pdf', ['Договор подряда (образец)', 'Отделочные работы в квартире 68 кв. м']]],
  },
  {
    key: 'goods', who: 'petrov', service: 'goods', stage: 'done', expert: 'zakharova', price: 14000, days: 10,
    title: 'Экспертиза стиральной машины: заводской брак или нет',
    fields: { purpose: 'damage', region: 'moscow', subject: 'Стиральная машина перестала отжимать через 2 месяца после покупки, магазин отказал в возврате.', questions: '1. Есть ли недостаток?\n2. Производственный он или эксплуатационный?', location: 'г. Москва, у владельца', purchase: '12.06.2026, магазин бытовой техники, 54 990 ₽' },
    docs: [['Чек и гарантийный талон.pdf', ['Кассовый чек (образец) 54 990 ₽']]],
    report: 'Заключение эксперта (товар).pdf', value: '',
  },
  {
    key: 'signature', who: 'lawyer', org: 'LAW', service: 'handwriting', stage: 'in_work', expert: 'zakharova', price: 25000, days: 14,
    title: 'Почерковедческая экспертиза подписи в расписке',
    fields: { purpose: 'court', region: 'moscow', object_kind: 'signature', document: 'Расписка от 12.03.2025', original: 'yes', samples: 'free', questions: 'Выполнена ли подпись в расписке от 12.03.2025 самим заёмщиком или другим лицом?' },
    docs: [['Скан расписки.pdf', ['Расписка (образец) от 12.03.2025']]],
    chat: [['zakharova', 'Для исследования нужен оригинал расписки и 5–10 свободных образцов подписи за 2023–2025 годы.']],
  },
  {
    key: 'equipment', who: 'banker', org: 'BANK', service: 'movable', stage: 'paid', price: 30000, days: 10,
    title: 'Оценка оборудования в залог (типография)',
    fields: { purpose: 'bank', region: 'mo', items: 'Печатная машина (вымышленная модель), 2019 г.\nРезальная машина, 2020 г.\nЛаминатор, 2022 г.', location: 'Московская обл., г. Пример, ул. Заводская, 1' },
    docs: [['Перечень оборудования.pdf', ['Перечень оборудования (образец)']]],
  },
  {
    key: 'office', who: 'banker', org: 'BANK', service: 'realty', stage: 'priced', price: 35000, days: 14,
    title: 'Оценка нежилого помещения для залога',
    fields: { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, ул. Образцовая, д. 8, пом. I', area: 140, floor: '1 / 5', year_built: 1985 },
  },
  {
    key: 'truck', who: 'banker', org: 'BANK', service: 'vehicle', stage: 'new', days: 14,
    title: 'Оценка грузовика, изъятого по лизингу',
    fields: { purpose: 'bank', region: 'mo', vehicle_type: 'truck', make_model: 'Тестмаш 3000 (вымышленный)', year: 2022 },
  },
  {
    key: 'share', who: 'sidorova', service: 'realty', stage: 'cancelled', days: 10,
    title: 'Оценка доли в квартире',
    fields: { purpose: 'division', region: 'moscow', object_type: 'share', address: 'г. Москва, ул. Тестовая, д. 1, кв. 3', area: 38, share_size: '1/2' },
  },
  {
    key: 'house', who: 'petrov', service: 'realty', stage: 'in_work', expert: 'tikhonov', price: 18000, days: 12,
    title: 'Оценка жилого дома для продажи',
    fields: { purpose: 'deal', region: 'mo', object_type: 'house', address: 'Московская обл., Истринский г. о., пос. Образцово, ул. Лесная, д. 2', area: 160, year_built: 2015 },
    docs: [['Выписка ЕГРН на дом.pdf', ['Выписка из ЕГРН (образец): жилой дом 160 кв. м']]],
  },
  {
    key: 'garden', who: 'sidorova', service: 'land', stage: 'closed', expert: 'morozova', price: 8000, days: 7,
    title: 'Оценка дачного участка (наследство)',
    fields: { purpose: 'inheritance', region: 'mo', address: 'Московская обл., СНТ «Демо», уч. 15', area: 600, land_use: 'garden', land_category: 'agricultural' },
    report: 'Отчёт об оценке участка.pdf', value: '1 150 000',
  },
  {
    key: 'crash', who: 'petrov', service: 'vehicle', stage: 'offered', expert: 'tikhonov', price: 7000, days: 5,
    title: 'Оценка ущерба автомобилю после ДТП',
    fields: { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Демомобиль Хэтчбек (вымышленный)', year: 2019, mileage: 91000 },
  },
];

// Вход: на площадке — служебный вход по тестовому номеру (stageLogin), на локальном стенде и в CI — код из поддельного
// СМС (codeLogin). Оба возвращают cookie сессии и пользователя.
export function stageLogin(base, headers, loginKey) {
  return async (phone) => {
    const h = { ...headers, 'x-delo-request': '1', 'x-stage-login': loginKey, 'content-type': 'application/json' };
    const r = await fetch(`${base}/__stage/login`, { method: 'POST', headers: h, body: JSON.stringify({ phone }) });
    if (r.status !== 200) throw new Error(`служебный вход ${phone}: ${r.status} ${await r.text()}`);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], user: (await r.json()).user };
  };
}

export function codeLogin(base, control) {
  return async (phone) => {
    const h = { 'x-delo-request': '1', 'content-type': 'application/json' };
    const c = await fetch(`${base}/api/auth/code`, { method: 'POST', headers: h, body: JSON.stringify({ phone }) });
    if (c.status !== 200) throw new Error(`код ${phone}: ${c.status} ${await c.text()}`);
    const calls = (await (await fetch(`${base}/__test/fakes/sms/calls`, { headers: { 'x-test-control': control } })).json()).calls;
    const code = calls.filter((x) => x.method === 'sendCode' && x.args.phone === phone).at(-1).args.code;
    const r = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: h, body: JSON.stringify({ phone, code }) });
    if (r.status !== 200) throw new Error(`вход ${phone}: ${r.status} ${await r.text()}`);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], user: (await r.json()).user };
  };
}

// Клиент: запоминает сессию; заголовки площадки (IAM-токен) — headers.
function makeClient(base, headers, login) {
  return async function enter(phone, name) {
    const s = await login(phone);
    let cookie = s.cookie;
    const req = async (method, path, body, { raw, type, fileName } = {}) => {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (method !== 'GET') h['x-delo-request'] = '1';
      let payload;
      if (raw) { payload = raw; h['content-type'] = type; h['x-file-name'] = encodeURIComponent(fileName); }
      else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
      const r = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: r.status, body: json };
    };
    const must = async (method, path, body, opts, ok = [200, 201]) => {
      const r = await req(method, path, body, opts);
      if (!ok.includes(r.status)) throw new Error(`${phone} ${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      return r.body;
    };
    const user = s.user;
    if (name && user.full_name !== name) await must('PATCH', '/api/me', { full_name: name });
    return { user, req, must, phone, get cookie() { return cookie; } };
  };
}

const pdf = (lines) => makePdf([lines]);
// Где что лежит: дела — по названию у их заказчика, организации — у руководителя.
async function locate(P) {
  const cases = {};
  for (const k of DEMO_CASES) {
    const o = (await P[k.who].must('GET', '/api/orders')).orders.find((x) => x.title === k.title);
    if (o) cases[k.key] = o.id;
  }
  const orgs = {};
  for (const [k, o] of Object.entries(DEMO_ORGS)) {
    const g = (await P[o.head].must('GET', '/api/orgs')).orgs.find((x) => x.name === o.name);
    if (g) orgs[k] = g.id;
  }
  return { cases, orgs };
}
const sessions = (P) => Object.fromEntries(Object.entries(P).map(([k, c]) => [k, c.cookie]));

// login — stageLogin(…) или codeLogin(…); adminPhone — уже назначенный администратор площадки (тестовый номер).
// Возвращает сессии демо-людей (sessions: ключ → cookie) — по ним экскурсия входит в кабинеты без нового кода.
export async function seedDemo({ base, headers = {}, login, adminPhone, log = () => {} }) {
  if (!login) throw new Error('нужен способ входа');
  if (!/^\+7999000\d{4}$/.test(adminPhone || '')) throw new Error('нужен тестовый номер администратора площадки');
  const enter = makeClient(base, headers, login);
  const P = {};
  for (const [k, p] of Object.entries(DEMO_PEOPLE)) P[k] = await enter(p.phone, p.name);
  // На показе подсказки первого входа не нужны (2.52): демо-люди «уже работали» на платформе.
  for (const c of Object.values(P)) for (const hint of ['customer', 'expert', 'head', 'dispatcher']) await c.must('POST', '/api/me/hints', { hint });

  // Уже наполнено — ничего не делаем (повторный запуск безопасен).
  const already = (await P.petrov.must('GET', '/api/orders')).orders;
  if (already.length) {
    log(`демо уже наполнено: у демо-заказчика ${already.length} заявок`);
    return { created: false, people: DEMO_PEOPLE, sessions: sessions(P), ...(await locate(P)) };
  }

  const admin = await enter(adminPhone);
  log('роли и допуски');
  const dispRole = await admin.req('PATCH', `/api/admin/users/${P.dispatcher.user.id}`, { platform_role: 'dispatcher' });
  if (dispRole.status !== 200) throw new Error(`роль диспетчера: ${dispRole.status} ${JSON.stringify(dispRole.body)}`);
  for (const [k, p] of Object.entries(DEMO_PEOPLE)) {
    if (!p.permits) continue;
    await admin.must('PUT', `/api/admin/specialists/${P[k].user.id}`, { regions: ['moscow', 'mo'], capacity: 8 });
    for (const service of p.permits) {
      await admin.must('POST', `/api/admin/specialists/${P[k].user.id}/permits`, { module: 'expertise', service }, undefined, [200, 201, 409]);
    }
  }

  log('организации');
  const ORG = {};
  for (const [ok, o] of Object.entries(DEMO_ORGS)) {
    const head = P[o.head];
    const org = (await head.must('POST', '/api/orgs', { name: o.name })).org;
    await head.must('PATCH', `/api/orgs/${org.id}`, { inn: o.inn, legal_address: 'г. Москва, ул. Примерная, д. 1 (демо)' });
    ORG[ok] = org;
    for (const [k, p] of Object.entries(DEMO_PEOPLE)) {
      if (p.org !== ok || k === o.head) continue;
      await head.must('POST', `/api/orgs/${org.id}/invites`, { phone: p.phone, role: 'member' });
      const inv = (await P[k].must('GET', '/api/invites')).invites.find((i) => i.org_name === o.name);
      if (!inv) throw new Error(`нет приглашения для ${p.name}`);
      await P[k].must('POST', `/api/invites/${inv.id}/accept`);
      if (p.permits) await P[k].must('PATCH', '/api/specialist/me', { org_id: org.id });
    }
  }

  log('досье экспертов');
  for (const [k, p] of Object.entries(DEMO_PEOPLE)) {
    if (!p.permits) continue;
    const c = P[k];
    const add = (b) => c.must('POST', '/api/specialist/me/dossier', b);
    await add({ kind: 'education', title: 'Демонстрационный университет, «Оценка и экспертиза»', number: `ДЕМО-${p.phone.slice(-3)}`, issued_on: '2012-06-30' });
    if (p.permits.some((s) => ['realty', 'land', 'vehicle', 'movable'].includes(s))) {
      await add({ kind: 'certificate', title: p.permits.includes('vehicle') ? 'Оценка движимого имущества' : 'Оценка недвижимости', number: `0${p.phone.slice(-3)}00-1`, issued_on: '2024-03-01', valid_until: inDays(500) });
      await add({ kind: 'sro', title: 'СРО оценщиков «Демо»', number: `${p.phone.slice(-4)}` });
      await add({ kind: 'policy', title: 'Страховая компания «Пример»', number: `ПОЛ-${p.phone.slice(-3)}`, issued_on: '2026-01-01', valid_until: inDays(k === 'tikhonov' ? 20 : 300), amount_rub: 5000000 });
    }
  }

  log('шаблон отчёта организации');
  await P.headA.must('POST', `/api/orgs/${ORG.A.id}/template`, undefined, {
    raw: makeDocx(['Центр оценки «Пример» (демо)', 'Шапка, реквизиты и логотип организации']),
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'Шаблон отчёта.docx',
  });

  const D = P.dispatcher;
  for (const k of DEMO_CASES) {
    log(`дело: ${k.title}`);
    const C = P[k.who];
    let o = (await C.must('POST', '/api/orders', { module: 'expertise', service: k.service, title: k.title, ...(k.org ? { org_id: ORG[k.org].id } : {}) })).order;
    await C.must('PATCH', `/api/orders/${o.id}`, { deadline: inDays(k.days), fields: k.fields });
    for (const [name, lines] of k.docs || []) {
      await C.must('POST', `/api/orders/${o.id}/documents`, undefined, { raw: pdf(lines), type: 'application/pdf', fileName: name });
    }
    const status = (to, who, from, extra = {}) => who.must('POST', `/api/orders/${o.id}/status`, { from, to, ...extra });
    if (k.stage === 'new') continue;
    if (k.stage === 'cancelled') {
      await status('matching', C, 'new');
      await status('cancelled', C, 'matching');
      continue;
    }
    await status('matching', C, 'new');
    await D.must('PUT', `/api/orders/${o.id}/price`, { price: String(k.price) });
    if (k.stage === 'priced') continue;
    await C.must('POST', `/api/orders/${o.id}/payments`);
    await C.must('POST', `/api/orders/${o.id}/payments/refresh`);
    if (k.stage === 'paid') continue;
    if (k.orgExec) {
      await D.must('POST', `/api/orders/${o.id}/offer`, { org_id: ORG[k.orgExec].id, from: 'matching' });
      continue;
    }
    const E = P[k.expert];
    await D.must('POST', `/api/orders/${o.id}/offer`, { specialist_id: E.user.id, from: 'matching' });
    if (k.stage === 'offered') continue;
    await status('in_work', E, 'awaiting_executor');
    for (const [who, text] of k.chat || []) await P[who].must('POST', `/api/orders/${o.id}/messages`, { body: text });
    if (k.stage === 'in_work') continue;

    // Результат: отчёт эксперта, подпись эксперта и (если он в организации) руководителя.
    const lines = [k.report.replace(/\.pdf$/, '').toUpperCase(), `Объект: ${k.title}`, 'Документ демонстрационный, данные вымышленные.',
      ...(k.value ? [`Итоговая величина рыночной стоимости: ${k.value} рублей.`] : ['Вывод: недостаток производственный (демонстрационный пример).'])];
    const res = (await E.must('POST', `/api/orders/${o.id}/results`, undefined, { raw: pdf(lines), type: 'application/pdf', fileName: k.report })).document;
    await E.must('POST', `/api/documents/${res.id}/sign`, { confirm: true });
    const orgKey = DEMO_PEOPLE[k.expert].org;
    if (orgKey) {
      const head = P[DEMO_ORGS[orgKey].head];
      const items = (await head.must('GET', `/api/orgs/${ORG[orgKey].id}/signing`)).items;
      const doc = items.flatMap((x) => x.documents).find((d) => d.id === res.id);
      if (!doc) throw new Error(`руководитель не видит файл на подпись: ${k.title}`);
      await head.must('POST', `/api/org-documents/${doc.id}/sign`, { confirm: true });
    }
    await E.must('POST', `/api/orders/${o.id}/messages`, { body: 'Результат приложен и подписан.' });
    await status('review', E, 'in_work');
    if (k.stage === 'review') continue;
    const rv = await D.must('GET', `/api/orders/${o.id}/review`);
    for (const c of rv.checks) await D.must('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
    await status('done', D, 'review');
    if (k.stage === 'done') continue;
    await C.must('POST', `/api/orders/${o.id}/messages`, { body: 'Спасибо, отчёт получили.' });
    await status('closed', C, 'done');
  }
  log(`готово: ${DEMO_CASES.length} дел`);
  return { created: true, people: DEMO_PEOPLE, sessions: sessions(P), ...(await locate(P)) };
}
