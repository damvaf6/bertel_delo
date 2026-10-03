// Автоматические находки в отчёте (решение Дамира 03.10.2026): ИИ-проверка ловит ошибки, найденные в настоящих отчётах
// об оценке транспорта. Здесь — только обезличенные выдержки: марки, организации, VIN, номера и суммы вымышленные
// (10-й знак VIN сохранён там, где по нему сверяется год). Настоящие отчёты в репозиторий не попадают.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoChecks, vinYears, wordsToNumber, tocEntries, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';
import { pagesForModel } from '../../src/ops/ai-ops.mjs';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { makePdf } from '../tools/make-docs.mjs';

const ALL = Object.keys(AUTO_CHECKS);
const doc = (pages, name = 'Отчёт.pdf') => ({ name, kind: 'pdf', pages });
const texts = (res, rule) => res[rule].map((f) => f.text);

// Выдержки «как в отчёте 221»: титул 2024 г.в., выводы 2019 г.в., оглавление без раздела 14 и с закладкой Word.
const TITLE = [
  'ОТЧЕТ ОБ ОЦЕНКЕ № 100/2026',
  'Объекта движимого имущества, которым является:',
  '- автобус «пригородный» Авто-Бус 1000-01 2024 г.в., VIN: XXX000000R0000000;',
  'ЗАКАЗЧИК: ООО «Заказчик-1»',
].join('\n');
const TOC = [
  'СОДЕРЖАНИЕ',
  '1. ОСНОВНЫЕ ФАКТЫ И ВЫВОДЫ. ........................................ 3',
  '2. ЗАДАНИЕ НА ОЦЕНКУ ............................................... 5',
  '3. ПРИМЕНЯЕМЫЕ В ОТЧЁТЕ ОБЩИЕ ПОНЯТИЯ И ОПРЕДЕЛЕНИЯ .................. 6',
  '4. ОБЩИЕ СВЕДЕНИЯ .................................................. 8',
  '4.1. ОСНОВАНИЕ ДЛЯ ПРОВЕДЕНИЯ ОЦЕНКИ ОБЪЕКТА ОЦЕНКИ, СВЕДЕНИЯ О ЗАКАЗЧИКЕ ........ 8',
  '12. АНАЛИЗ РЫНКА ОБЪЕКТА ОЦЕНКИ И ОБОСНОВАНИЕ ЗНАЧЕНИЙ ИЛИ ДИАПАЗОНОВ',
  'ЗНАЧЕНИЙ ЦЕНООБРАЗУЮЩИХ ФАКТОРОВ ....................................... 15',
  '13. ОБОСНОВАНИЕ ПРИМЕНЕНИЯ ОСНОВНЫХ ПОДХОДОВ К ОЦЕНКЕ ........ 16',
  '15. РАСЧЕТ РЫНОЧНОЙ СТОИМОСТИ ОБЪЕКТА ОЦЕНКИ. ........ 16',
  '15.1. ОПРЕДЕЛЕНИЕ СТОИМОСТИ С ИСПОЛЬЗОВАНИЕМ ЗАТРАТНОГО ПОДХОДА. ........ 16',
  '15.2. ОПРЕДЕЛЕНИЕ СТОИМОСТИ С ИСПОЛЬЗОВАНИЕМ СРАВНИТЕЛЬНОГО',
  'ПОДХОДА. ..................................... ОШИБКА! ЗАКЛАДКА НЕ ОПРЕДЕЛЕНА.',
  '16. ОБОБЩЕНИЕ РЕЗУЛЬТАТОВ, ПОЛУЧЕННЫХ В РАМКАХ КАЖДОГО ИЗ ПОДХОДОВ К',
  'ОЦЕНКЕ, И ОПРЕДЕЛЕНИЕ ИТОГОВОЙ ВЕЛИЧИНЫ РЫНОЧНОЙ СТОИМОСТИ ОБЪЕКТА',
  'ОЦЕНКИ ................................................................ 19',
  '17. НОРМАТИВНЫЕ ДОКУМЕНТЫ, ЛИТЕРАТУРА И УЧЕБНЫЕ ПОСОБИЯ ПО ОЦЕНОЧНОЙ',
  'ДЕЯТЕЛЬНОСТИ. ......................................................... 19',
].join('\n');
const FACTS = [
  '1. ОСНОВНЫЕ ФАКТЫ И ВЫВОДЫ.',
  'В соответствии с Договором на проведение оценки №1/2026 от 25 августа 2026 года',
  'оценщиком ООО «Оценщик-1» Ивановым И.И. была проведена оценка объекта:',
  '- автобус «пригородный» Авто-Бус 1000-01 2019 г.в., VIN: XXX000000R0000000;',
  'и определена рыночная стоимость Объекта оценки для последующего предоставления в суд.',
  'Рыночная стоимость объекта: автобус «пригородный» Авто-Бус 1000-01 2024 г.в., VIN: XXX000000R0000000;',
  'по состоянию на 25 августа 2026 года составляет:',
  '9 700 000,00 = (Девять миллионов семьсот тысяч) рублей',
  'От оценщика не требуется давать свидетельство или появляться в суде вследствие проведения оценки данной собственности.',
].join('\n');
const APPROACHES = [
  'В данном случае не удалось обнаружить предложений по продаже объектов аналогичных',
  'оцениваемому на вторичном рынке. В виду этого отсутствует возможность применить',
  'сравнительный подход для определения стоимости объекта оценки.',
  'При отсутствии документально подтвержденных имущественных прав третьих лиц в',
  'отношении оцениваемого объекта недвижимости, ограничений (обременений) ...',
].join('\n');
const REPORT_221 = [TITLE, TOC, FACTS, APPROACHES];

test('отчёт как «221»: год в выводах не тот, закладка Word, нет раздела 14, подход в оглавлении отвергнут, суд, шаблон', () => {
  const res = runAutoChecks(ALL, [doc(REPORT_221)], { fields: { purpose: 'court' } });
  assert.deepEqual(texts(res, 'vehicle_year'), ['Год выпуска не совпадает: здесь 2019, а в остальных местах 2024; по VIN тоже 2024']);
  assert.equal(res.vehicle_year[0].where, 'стр. 3');
  assert.match(res.vehicle_year[0].quote, /Авто-Бус 1000-01 2019 г\.в\./);
  assert.deepEqual(texts(res, 'word_fields'), ['Служебная строка Word «ОШИБКА! ЗАКЛАДКА НЕ ОПРЕДЕЛЕНА.» — поле или ссылка не обновились']);
  assert.equal(res.word_fields[0].where, 'стр. 2');
  assert.deepEqual(texts(res, 'section_gaps'), ['Нумерация разделов: после раздела 13 сразу 15 — раздела 14 нет (по оглавлению)'],
    'перенесённые названия разделов 12, 16 и 17 — не пропуски');
  assert.deepEqual(texts(res, 'approaches_toc'), ['В оглавлении есть раздел 15.2 про сравнительный подход, а в тексте сказано, что он не применялся']);
  assert.deepEqual(texts(res, 'court_purpose'), ['Оценка для суда, а в ограничениях сказано, что оценщику не нужно являться в суд — противоречие']);
  assert.equal(res.template_leftovers.length, 1);
  assert.match(res.template_leftovers[0].text, /объекта недвижимости/);
  assert.deepEqual(res.sum_words, [], 'прописью совпадает с цифрами');
  assert.deepEqual(res.vin_year, [], '10-й знак R — 2024, как в отчёте');
  assert.deepEqual(res.rounding, []);
});

test('тот же отчёт без ошибок — находок нет', () => {
  const fixed = REPORT_221.map((p) => p
    .replace('2019 г.в.', '2024 г.в.')
    .replace('ОШИБКА! ЗАКЛАДКА НЕ ОПРЕДЕЛЕНА.', '17')
    .replace(/^15\./m, '14. ВЫБОР ПОДХОДОВ ........ 16\n15.')
    .replace(/15\.2\. ОПРЕДЕЛЕНИЕ[^\n]*\n[^\n]*\n/, '')
    .replace('объекта недвижимости', 'объекта оценки')
    .replace(/От оценщика не требуется[^\n]*/, ''));
  const res = runAutoChecks(ALL, [doc(fixed)], { fields: { purpose: 'court' } });
  for (const rule of ALL) assert.deepEqual(res[rule], [], rule);
});

test('отчёт как «241»: несколько машин — год сверяется по каждому VIN, округление на 4,7%, модельный год по VIN', () => {
  const title = [
    'ОТЧЕТ ОБ ОЦЕНКЕ № 200/2026',
    '- легковой автомобиль Нортон Сириус V8 2018 г.в., VIN: XWZTEST01KA000001,',
    'гос.рег.номер В002ВВ799. Дата оценки – 26 марта 2025 года;',
    '- легковой автомобиль Нортон Аврора 2020 г.в., VIN: XWZTEST02LA000002,',
    'гос.рег.номер А001АА799. Дата оценки – 04 марта 2025 года;',
    '- легковой автомобиль Европа Люкс 2021 г.в., VIN: WEUTEST0310000003,',
  ].join('\n');
  const totals = [
    'Наименование Стоимость затратным Вес Стоимость доходным Вес Стоимость сравнительным Вес Итог',
    'Автомобиль Нортон Сириус V8 Не применялся - Не применялся - 3 148 760,14 1,0 3 000 000,00',
    'Автомобиль Нортон Аврора Не применялся - Не применялся - 5 589 752,10 1,0 5 600 000,00',
    'Рыночная стоимость составляет 5 600 000,00 = (Пять миллионов шестьсот тысяч) рублей.',
  ].join('\n');
  const res = runAutoChecks(ALL, [doc([title, totals])], {});
  assert.deepEqual(res.vehicle_year, [], 'у каждой машины свой год — это не расхождение');
  assert.deepEqual(texts(res, 'vin_year'), ['Год выпуска 2018, а 10-й знак VIN «K» означает модельный 2019 год — так бывает, но в отчёте стоит пояснить'],
    'европейский VIN без года (10-й знак «1») — молчим');
  assert.deepEqual(texts(res, 'rounding'), ['Итог 3 000 000 отличается от расчёта 3 148 760 на -4,7% — проверьте правило округления'],
    'округление на 0,2% — не находка');
  assert.deepEqual(res.sum_words, []);
});

test('сумма цифрами и прописью; числа прописью; год по VIN; оглавление с переносами', () => {
  assert.equal(wordsToNumber('Девять миллионов семьсот тысяч'), 9_700_000);
  assert.equal(wordsToNumber('Два миллиона четыреста пятьдесят шесть тысяч двести четырнадцать'), 2_456_214);
  assert.equal(wordsToNumber('Одна тысяча'), 1000);
  assert.equal(wordsToNumber('сто рублей'), 100);
  assert.equal(wordsToNumber('много денег'), null);
  const res = runAutoChecks(['sum_words'], [doc(['Итог: 4 100 000,00 = (Четыре миллиона сто тысяч) рублей', 'составляет 3 500 000 (Три миллиона семьсот тысяч) рублей'])]);
  assert.deepEqual(texts(res, 'sum_words'), ['Сумма цифрами 3 500 000 не совпадает с суммой прописью (3 700 000)']);
  assert.equal(res.sum_words[0].where, 'стр. 2');
  assert.ok(vinYears('XXX000000R0000000').includes(2024));
  assert.ok(vinYears('XXX000000K0000000').includes(2019));
  assert.ok(vinYears('XXX00000050000000').includes(2005));
  assert.deepEqual(vinYears('XXX000000I0000000'), [], 'I в VIN не бывает');
  const toc = tocEntries('1. ВВЕДЕНИЕ ...... 3\n9. ТОЧНОЕ ОПИСАНИЕ ОБЪЕКТА, ЕГО БАЛАНСОВАЯ\nСТОИМОСТЬ. ............ 12\n1. Пункт списка без отточия');
  assert.deepEqual(toc.map((e) => [e.num, e.top]), [['1', 1], ['9', 9]]);
});

test('служебные строки Word разных видов; остатки шаблона не ищутся там, где их не просили', () => {
  const res = runAutoChecks(['word_fields'], [doc(['См. таблицу Ошибка! Источник ссылки не найден.', 'Error! Bookmark not defined.'])]);
  assert.equal(res.word_fields.length, 2);
  assert.deepEqual(runAutoChecks([], [doc(['объект недвижимости'])]), {});
  assert.deepEqual(runAutoChecks(['template_leftovers'], [{ name: 'фото.jpg', kind: null, pages: null }]), { template_leftovers: [] }, 'нечитаемый файл пропускается');
});

test('модели — главные страницы, если весь отчёт не помещается: начало, выводы, расчёт и итог; пометка о пропуске', () => {
  const pages = Array.from({ length: 30 }, (_, i) => `Страница ${i + 1}. ${'текст '.repeat(300)}`);
  pages[25] = `Согласование результатов и итоговая величина стоимости. ${'итог '.repeat(300)}`;
  const { text, truncated } = pagesForModel(pages, 12_000);
  assert.equal(truncated, true);
  assert.match(text, /--- стр\. 1 ---/);
  assert.match(text, /--- стр\. 26 ---\nСогласование/);
  assert.match(text, /страниц не передано: \d+ из 30/);
  assert.ok(text.length < 12_200);
  assert.deepEqual(pagesForModel(['коротко'], 100), { text: 'коротко', truncated: false });
});

// ——— Через ИИ-проверку в деле: находки видны исполнителю и диспетчеру, модель их получает и не повторяет ———
let S, owner, dispatcher, spec;
before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000861');
  dispatcher = await login(S, '+79990000862');
  spec = await login(S, '+79990000863');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

test('ИИ-проверка оценки транспорта: автоматические находки под своими правилами, со страницей; модель видит их в запросе', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Тестовый автобус' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, {
    deadline: addDays(todayMsk(), 10),
    fields: { purpose: 'court', region: 'mo', vehicle_type: 'other', make_model: 'Авто-Бус 1000-01', year: 2024, vin: 'XXX000000R0000000' },
  })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  const pdf = makePdf(REPORT_221.map((p) => p.split('\n')));
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, pdf, { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт (тест).pdf') } })).status, 201);
  S.providers.ai.reset();
  const r = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const items = Object.fromEntries(r.body.ai.items.map((i) => [i.id, i]));
  assert.ok(items.vehicle_identity, 'правило про транспорт есть только у оценки транспорта');
  assert.equal(items.vehicle_identity.hint, 'attention');
  assert.deepEqual(items.vehicle_identity.found.map((f) => [f.file, f.where]), [['Отчёт (тест).pdf', 'стр. 3']]);
  assert.match(items.vehicle_identity.found[0].text, /здесь 2019, а в остальных местах 2024/);
  assert.deepEqual(items.technical.found.map((f) => f.where), ['стр. 2', 'стр. 2']);
  assert.equal(items.approaches.found.length, 1);
  assert.equal(items.error_margin.found.length, 1, 'для суда — а «не требуется появляться в суде»');
  assert.equal(items.template.found.length, 1);
  assert.equal(items.calculation.found, undefined);
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /УЖЕ НАЙДЕНО АВТОМАТИЧЕСКИ/);
  assert.match(prompt, /vehicle_identity: Год выпуска не совпадает/);
  assert.match(prompt, /Что проверить: год выпуска одинаков на титуле/);
  // Модель недоступна — находки всё равно показываются, ошибки нет.
  S.providers.ai.script({ kind: 'fail' });
  const r2 = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(r2.status, 201);
  assert.equal(r2.body.ai.model, 'auto');
  assert.equal(r2.body.ai.items.find((i) => i.id === 'technical').found.length, 2);
  assert.match(r2.body.ai.items.find((i) => i.id === 'requisites').note, /проверьте сами/);
  S.providers.ai.script();
});

// ——— Новые виды экспертиз (путь 2, пункт г): заявка, правила, черновик, осмотр — данными в модуле, код ядра не менялся ———
test('строительно-техническая и почерковедческая: поля заявки обязательны, свои правила ИИ-проверки, разделы черновика и шаги осмотра', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(reg.checks('expertise', 'construction')).filter((id) => id.startsWith('st_')), ['st_norms', 'st_inspection', 'st_cost']);
  assert.deepEqual(ids(reg.checks('expertise', 'handwriting')).filter((id) => id.startsWith('hw_')), ['hw_objects', 'hw_method']);
  assert.ok(ids(reg.checks('expertise', 'handwriting')).includes('expert_info'));
  assert.ok(!ids(reg.checks('expertise', 'handwriting')).includes('calculation'), 'у почерковедческой нет расчёта стоимости');
  assert.ok(!ids(reg.checks('expertise', 'construction')).includes('vehicle_identity'));
  assert.equal(reg.draftSections('expertise', 'construction').length, 8);
  assert.match(reg.draftSections('expertise', 'handwriting').map((d) => d.title).join('\n'), /Объекты исследования и образцы/);
  assert.ok(ids(reg.inspectionSteps('expertise', 'construction')).includes('st_defects'));
  assert.ok(ids(reg.inspectionSteps('expertise', 'handwriting')).includes('hw_signature'));

  for (const [service, fields] of [
    ['construction', { purpose: 'court', region: 'moscow', object_kind: 'flat', task: 'defects', address: 'г. Москва, Тестовая ул., 1', questions: 'Есть ли недостатки ремонта и сколько стоит их устранить?' }],
    ['handwriting', { purpose: 'court', region: 'mo', object_kind: 'signature', document: 'тестовая расписка от 01.02.2026', original: 'yes', samples: 'free', questions: 'Выполнена ли подпись тем, от чьего имени она значится?' }],
  ]) {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: `Тест: ${service}` })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 15) })).status, 200);
    const early = await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' });
    assert.equal(early.status, 400, 'без обязательных полей не отправить');
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { fields })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200, service);
  }
});
