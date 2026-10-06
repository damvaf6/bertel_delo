// Автоматические находки в отчёте (решение Дамира 03.10.2026): ИИ-проверка ловит ошибки, найденные в настоящих отчётах
// об оценке транспорта. Здесь — только обезличенные выдержки: марки, организации, VIN, номера и суммы вымышленные
// (10-й знак VIN сохранён там, где по нему сверяется год). Настоящие отчёты в репозиторий не попадают.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoChecks, vinYears, wordsToNumber, tocEntries, AUTO_CHECKS, purchaseOf, questionsOf } from '../../src/ai/report-checks.mjs';
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
  // Выдержка — не весь отчёт: обязательных сведений (2.38) в ней и не должно быть полностью.
  for (const rule of ALL.filter((r) => r !== 'required_items')) assert.deepEqual(res[rule], [], rule);
});

// 2.38: то, что суды проверяют первым, — обязательные сведения отчёта (ст. 11 закона № 135-ФЗ, ФСО VI); экспертиза по
// определению суда — номер определения и ст. 307 УК РФ; VIN как в заявке; дата составления не раньше даты оценки.
const FULL = [
  'ОТЧЕТ ОБ ОЦЕНКЕ № 300/2026\nДата составления отчёта: 20.09.2026\nОснование: договор № 7 от 01.09.2026',
  'Цель оценки — для суда. Вид стоимости — рыночная стоимость. Дата оценки: 15.09.2026.\nДопущения и ограничительные условия.',
  'Применены стандарты оценки ФСО I–VI. Оценщик — член СРО «Тест», ответственность застрахована.\nСравнительный подход. VIN: XXX000000R0000000',
].map((p) => p.replace(/\\n/g, '\n'));

test('обязательные сведения отчёта (2.38): полный отчёт — молчим; чего нет — одной находкой со списком', () => {
  assert.deepEqual(runAutoChecks(['required_items'], [doc(FULL)]).required_items, []);
  const cut = FULL.map((p) => p.replace(/Дата оценки: 15\.09\.2026\./, '').replace(/член СРО «Тест», /, ''));
  const r = runAutoChecks(['required_items'], [doc(cut), doc(['Копия диплома'], 'Диплом.pdf')]).required_items;
  assert.equal(r.length, 1);
  assert.equal(r[0].file, 'Отчёт.pdf', 'проверяется основной отчёт, а не копии документов');
  assert.match(r[0].text, /не найдено: дата оценки, членство оценщика в СРО — по закону об оценке/);
});

test('по определению суда (2.38): номер определения и ст. 307 УК РФ; по договору — не требуется', () => {
  const basis = { kind: 'court', number: '2-1234/2026' };
  let r = runAutoChecks(['court_order'], [doc(FULL)], { basis }).court_order.map((f) => f.text);
  assert.deepEqual(r, ['Номер определения суда 2-1234/2026 в отчёте не найден — укажите основание с номером и датой',
    'Экспертиза по определению суда, а предупреждения об ответственности по ст. 307 УК РФ в отчёте нет']);
  const ok = [...FULL, 'Определение суда по делу № 2-1234/2026. Об уголовной ответственности по ст. 307 УК РФ предупреждён.'];
  assert.deepEqual(runAutoChecks(['court_order'], [doc(ok)], { basis }).court_order, []);
  assert.deepEqual(runAutoChecks(['court_order'], [doc(FULL)], { basis: { kind: 'contract' } }).court_order, []);
});

test('VIN как в заявке и порядок дат (2.38): чужой VIN рядом со словом VIN; составлен раньше даты оценки', () => {
  const fields = { vin: 'XXX000000R0000000', more_vehicles: 'Второй автобус, VIN XXX000000R0000002' };
  assert.deepEqual(runAutoChecks(['vin_match'], [doc(FULL)], { fields }).vin_match, []);
  const other = [...FULL, 'Аналог: VIN XXX000000R0000002 — из заявки, свой.\nVIN: WDB0000000A123456 — от старого отчёта.'.replace('\\n', '\n')];
  const r = runAutoChecks(['vin_match'], [doc(other)], { fields }).vin_match;
  assert.deepEqual(r.map((f) => f.text), ['VIN WDB0000000A123456 не совпадает с VIN из заявки (XXX000000R0000000) — проверьте, нет ли данных другой машины']);
  assert.deepEqual(runAutoChecks(['vin_match'], [doc(other)], {}).vin_match, [], 'без VIN в заявке — молчим');
  assert.deepEqual(runAutoChecks(['date_order'], [doc(FULL)]).date_order, []);
  const early = FULL.map((p) => p.replace('20.09.2026', '10.09.2026'));
  assert.deepEqual(runAutoChecks(['date_order'], [doc(early)]).date_order.map((f) => f.text), ['Дата составления отчёта (10.09.2026) раньше даты оценки (15.09.2026) — так быть не может']);
  const words = ['Дата оценки — 26 марта 2025 года', 'Дата составления отчёта — 4 марта 2025 года'];
  assert.equal(runAutoChecks(['date_order'], [doc(words)]).date_order.length, 1, 'даты словами');
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

test('недвижимость и земля (2.43): чужой кадастровый номер и остатки отчёта о машине; номера аналогов и квартала — не находка', () => {
  const page = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 12 квартиры',
    'Объект оценки: квартира, кадастровый номер 77:01:0001001:1234, площадь 54,3 кв. м',
    'Кадастровый номер объекта 77:05:0007003:999 (по выписке ЕГРН)',
    'Кадастровый квартал 77:01:0001001',
    'Аналог 2: кадастровый номер 77:01:0001001:555',
    'Пробег объекта оценки не определялся. VIN отсутствует.',
  ].join('\n');
  const res = runAutoChecks(['cadastral_match', 'template_leftovers'], [doc([page])], { fields: { cadastral: '77:01:0001001:1234' }, service: 'realty' });
  assert.deepEqual(texts(res, 'cadastral_match'), ['Кадастровый номер 77:05:0007003:999 не совпадает с номером из заявки (77:01:0001001:1234) — проверьте, нет ли данных другого объекта']);
  assert.deepEqual(res.template_leftovers.map((f) => f.text), [
    '«Пробег» в отчёте об оценке недвижимости — возможно, остаток шаблона другого отчёта',
    '«VIN» в отчёте об оценке недвижимости — возможно, остаток шаблона другого отчёта',
  ]);
  // В отчёте о квартире слова «земельный участок» — не остаток шаблона; в отчёте о машине — остаток.
  const flat = runAutoChecks(['template_leftovers'], [doc(['Дом расположен на земельном участке площадью 1200 кв. м'])], { service: 'realty' });
  assert.deepEqual(flat.template_leftovers, []);
  const car = runAutoChecks(['template_leftovers'], [doc(['Дом расположен на земельном участке'])], { service: 'vehicle' });
  assert.equal(car.template_leftovers.length, 1);
  assert.match(runAutoChecks(['template_leftovers'], [doc(['Автомобиль на участке'])], { service: 'land' }).template_leftovers[0].text, /земельного участка/);
  assert.deepEqual(runAutoChecks(['cadastral_match'], [doc([page])], { fields: {} }).cadastral_match, [], 'без номера в заявке — не сверяем');
});

test('недвижимость и земля (2.59): площадь, этаж и этажность, доля — как в заявке; аналоги, кухня, дом и участок — не находка', () => {
  const flat = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 15 доли в квартире',
    'Объект оценки: 1/3 доли в праве общей долевой собственности на квартиру общей площадью 54,3 кв. м',
    'Квартира расположена на 5 этаже 9-этажного жилого дома.',
    'Описание объекта: общая площадь 45,1 кв. м, жилая площадь 30,2 кв. м, площадь кухни 8,4 кв. м',
    'Этаж / этажность: 7 / 12',
    'Рыночная стоимость доли 1/4 в праве собственности составляет 3 100 000 рублей',
    'Дом расположен на земельном участке площадью 1 200 кв. м; площадь дома 3 400 кв. м',
    'Аналог 1: квартира площадью 52 кв. м на 3 этаже 5-этажного дома, доля 1/2',
  ].join('\n');
  const fields = { area: 54.3, floor: '5 / 9', share_size: '1/3', object_type: 'share' };
  const res = runAutoChecks(['area_match', 'floor_match', 'share_match'], [doc([flat])], { fields, service: 'realty' });
  assert.deepEqual(texts(res, 'area_match'), ['Площадь 45,1 кв. м не совпадает с площадью из заявки (54,3 кв. м) — проверьте, нет ли данных другого объекта']);
  assert.deepEqual(texts(res, 'floor_match'), [
    'Этаж 7 не совпадает с этажом из заявки (5) — проверьте, нет ли данных другого объекта',
    'Этажей в доме 12, а в заявке 9 — проверьте, нет ли данных другого дома',
  ]);
  assert.deepEqual(texts(res, 'share_match'), ['Доля 1/4 не совпадает с долей из заявки (1/3) — проверьте расчёт и описание объекта']);
  assert.equal(res.area_match[0].where, 'стр. 1');
  // Всё как в заявке — находок нет; без полей в заявке — не сверяем; 2/6 = 1/3.
  const ok = flat.split('\n').filter((l) => !/45,1|7 \/ 12|1\/4/.test(l)).join('\n') + '\nДоля 2/6 в праве';
  const clean = runAutoChecks(['area_match', 'floor_match', 'share_match'], [doc([ok])], { fields, service: 'realty' });
  assert.deepEqual([clean.area_match, clean.floor_match, clean.share_match], [[], [], []]);
  const none = runAutoChecks(['area_match', 'floor_match', 'share_match'], [doc([flat])], { fields: {}, service: 'realty' });
  assert.deepEqual([none.area_match, none.floor_match, none.share_match], [[], [], []]);
  // Только этаж в заявке («5») — этажность не сверяем.
  assert.deepEqual(texts(runAutoChecks(['floor_match'], [doc([flat])], { fields: { floor: '5' }, service: 'realty' }), 'floor_match'),
    ['Этаж 7 не совпадает с этажом из заявки (5) — проверьте, нет ли данных другого объекта']);
});

test('земля (2.59): площадь в сотках и гектарах, категория земель и вид разрешённого использования — как в заявке', () => {
  const land = [
    'Объект оценки: земельный участок площадью 12 соток, кадастровый номер 50:20:0010101:77',
    'Площадь участка по выписке ЕГРН: 1 200 кв. м',
    'Площадь земельного участка 0,15 га',
    'Категория земель: земли сельскохозяйственного назначения',
    'Вид разрешённого использования: для ведения личного подсобного хозяйства',
    'Вид разрешенного использования — для размещения объектов торговли',
    'На участке жилой дом площадью 120 кв. м',
    'Аналог 2: категория земель — земли населённых пунктов, ИЖС, площадь 10 соток',
  ].join('\n');
  const res = runAutoChecks(['area_match', 'land_match'], [doc([land])], { fields: { area: 1200, land_category: 'settlement', land_use: 'izhs' }, service: 'land' });
  assert.deepEqual(texts(res, 'area_match'), ['Площадь 1 500 кв. м не совпадает с площадью из заявки (1 200 кв. м) — проверьте, нет ли данных другого объекта']);
  assert.deepEqual(texts(res, 'land_match'), [
    'Категория земель «земли сельскохозяйственного назначения» не совпадает с заявкой («земли населённых пунктов») — сверьте с выпиской ЕГРН',
    'Вид разрешённого использования «для размещения объектов торговли» не похож на назначение из заявки («под жилой дом (ИЖС)») — сверьте с выпиской ЕГРН',
  ]);
  // «Другая или не знаю» и «Другое» — не сверяем.
  const other = runAutoChecks(['land_match'], [doc([land])], { fields: { land_category: 'other', land_use: 'other' }, service: 'land' });
  assert.deepEqual(other.land_match, []);
});

test('недвижимость и земля (2.59): новые правила подключены к проверке «Адрес, кадастровый номер, площадь»', async () => {
  const { DEFAULT_MODULES } = await import('../../src/modules/index.mjs');
  const exp = DEFAULT_MODULES.find((m) => m.id === 'expertise');
  const rule = exp.checks.find((c) => c.id === 'realty_identity');
  assert.deepEqual(rule.auto, ['cadastral_match', 'area_match', 'floor_match', 'share_match', 'land_match']);
});

test('остальные виды оценки (2.43): правила проверки как у транспорта — сверка объекта, шаблон, обязательные сведения', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  const of = (svc) => reg.checks('expertise', svc).map((c) => c.id);
  for (const svc of ['realty', 'land']) {
    for (const id of ['realty_identity', 'rights', 'calculation', 'approaches', 'analogs', 'appraiser', 'template', 'technical']) assert.ok(of(svc).includes(id), `${svc}: ${id}`);
  }
  for (const id of ['rights', 'calculation', 'approaches', 'analogs', 'appraiser', 'template']) assert.ok(of('movable').includes(id), `movable: ${id}`);
  for (const id of ['expert_info', 'conclusions', 'questions_answered', 'calculation']) assert.ok(of('goods').includes(id), `goods: ${id}`);
  assert.ok(!of('vehicle').includes('realty_identity'));
});

test('транспорт (2.60): госномер и пробег — как в заявке; номера аналогов, среднегодовой пробег и рост пробега до 10% — не находка', () => {
  const fields = { vin: 'XXX000000R0000000', reg_number: 'А001АА799', mileage: 120000 };
  const page = [
    'Объект оценки: автобус Авто-Бус 1000-01, VIN: XXX000000R0000000, гос. рег. знак A001AA799 (латиницей — тот же номер).',
    'Пробег по показаниям одометра: 125 000 км.',
    'Среднегодовой пробег для автобусов — 60 000 км в год.',
    'Аналог №1: Авто-Бус 1000-01, г/н В002ВВ799, пробег 300 000 км.',
  ].join('\n');
  const ok = runAutoChecks(['reg_match', 'mileage_match'], [doc([page])], { fields });
  assert.deepEqual(ok.reg_match, []);
  assert.deepEqual(ok.mileage_match, [], 'пробег вырос на 4% — так бывает');
  const bad = runAutoChecks(['reg_match', 'mileage_match'], [doc([page, 'Госномер В777ОР77. Пробег объекта — 48 тыс. км.'])], { fields });
  assert.deepEqual(texts(bad, 'reg_match'), ['Госномер В777ОР77 не совпадает с госномером из заявки (А001АА799) — проверьте, нет ли данных другой машины']);
  assert.equal(bad.reg_match[0].where, 'стр. 2');
  assert.deepEqual(texts(bad, 'mileage_match'), ['Пробег 48 000 км не совпадает с пробегом из заявки (120 000 км) — проверьте, нет ли данных другой машины']);
  assert.deepEqual(runAutoChecks(['reg_match', 'mileage_match'], [doc([page])], { fields: {} }), { reg_match: [], mileage_match: [] }, 'в заявке нет — не сверяем');
});

test('все виды оценки (2.60): веса подходов в сумме 1 — строка на подход и столбцы «Вес» у нескольких машин', () => {
  const good = ['СОГЛАСОВАНИЕ РЕЗУЛЬТАТОВ', 'Подход Стоимость, руб. Вес', 'Затратный подход 1 200 000 0,4', 'Сравнительный подход 1 300 000 0,6', 'Доходный подход не применялся -'].join('\n');
  assert.deepEqual(runAutoChecks(['approach_weights'], [doc([good])]).approach_weights, []);
  const bad = good.replace('0,6', '0,5');
  assert.deepEqual(texts(runAutoChecks(['approach_weights'], [doc([bad])]), 'approach_weights'), ['Веса подходов в согласовании в сумме 0,9, а должно быть 1']);
  const pct = ['Обобщение результатов, вес подхода', 'Затратный подход — 30%', 'Сравнительный подход — 50%'].join('\n');
  assert.deepEqual(texts(runAutoChecks(['approach_weights'], [doc([pct])]), 'approach_weights'), ['Веса подходов в согласовании в сумме 0,8, а должно быть 1']);
  const table = [
    'Итоговая рыночная стоимость',
    'Наименование Стоимость затратным Вес Стоимость доходным Вес Стоимость сравнительным Вес Итог',
    'Автомобиль Нортон Сириус V8 Не применялся - Не применялся - 3 148 760,14 1,0 3 100 000,00',
    'Автомобиль Нортон Аврора 2 000 000,00 0,5 Не применялся - 5 589 752,10 0,3 5 600 000,00',
  ].join('\n');
  assert.deepEqual(texts(runAutoChecks(['approach_weights'], [doc([table])]), 'approach_weights'), ['Веса подходов в строке в сумме 0,8, а должно быть 1']);
});

test('аналоги (2.60): не меньше трёх; одна ссылка у разных аналогов — находка; сравнительный не применялся — молчим', () => {
  const three = [
    'Сравнительный подход',
    'Аналог №1 — https://auto.example.ru/cars/1 — 3 100 000 руб.',
    'Аналог №2 — https://auto.example.ru/cars/2 — 3 250 000 руб.',
    'Аналог №3 — https://www.auto.example.ru/cars/3/ — 3 000 000 руб.',
  ].join('\n');
  assert.deepEqual(runAutoChecks(['analog_list'], [doc([three])]).analog_list, []);
  const two = three.split('\n').slice(0, 3).join('\n');
  assert.deepEqual(texts(runAutoChecks(['analog_list'], [doc([two])]), 'analog_list'), ['В сравнительном подходе два аналога — нужно не меньше трёх']);
  const dup = three.replace('cars/3/', 'cars/1/');
  assert.deepEqual(texts(runAutoChecks(['analog_list'], [doc([dup])]), 'analog_list'), ['Одна и та же ссылка у аналогов № 1 и № 3 — у каждого аналога должно быть своё объявление']);
  const refused = 'Сравнительный подход не применялся: аналог №1 найден один, предложений недостаточно.';
  assert.deepEqual(runAutoChecks(['analog_list'], [doc([refused])]).analog_list, []);
});

test('2.75: аналоги в отчёте — как подтверждённые в деле: ссылка, цена, цена после корректировок, площадь, лишние номера', () => {
  const analogs = [
    { url: 'https://www.cian.ru/sale/flat/401/?utm_source=x', fields: { price_rub: 14000000, area: 50.5 }, adjustments: [] },
    { url: 'https://m.avito.ru/moskva/kvartiry/402', fields: { price_rub: 14500000, area: 51 }, adjustments: [{ kind: 'bargain', pct: -5 }] },
    { url: 'https://domclick.ru/card/sale__flat__403', fields: { price_rub: 15000000, area: 52 }, adjustments: [] },
  ];
  const ok = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 7/2026',
    'Сравнительный подход',
    '| № | Источник | Цена, руб. | Площадь, кв. м | Корректировки, всего | Цена после корректировок, руб. |',
    '| 1 | cian.ru | 14 000 000 | 50,5 | нет | 14 000 000 |',
    '| 2 | avito.ru | 14 500 000 | 51 | −5 % | 13 775 000 |',
    '| 3 | domclick.ru | 15 000 000 | 52 | нет | 15 000 000 |',
    'Приложение. Скриншоты объявлений (аналоги)',
    'Аналог 1 — cian.ru', 'Ссылка: https://www.cian.ru/sale/flat/401/',
    'Аналог 2 — avito.ru', 'Ссылка: https://www.avito.ru/moskva/kvar', 'tiry/402',
    'Аналог 3 — domclick.ru', 'Ссылка: https://domclick.ru/card/sale__flat__403',
  ].join('\n');
  const run = (text, list = analogs) => texts(runAutoChecks(['analog_match'], [doc([text])], { analogs: list }), 'analog_match');
  assert.deepEqual(run(ok), [], 'всё сходится; перенос ссылки в PDF и «www»/«m.» не мешают');
  assert.deepEqual(run(ok, []), [], 'в деле аналогов нет — молчим');
  assert.deepEqual(run(ok.replace('14 500 000', '14 600 000')), [], 'цена до корректировок не найдена, но после — есть: молчим');
  assert.deepEqual(run(ok.replace('15 000 000 | 52 | нет | 15 000 000', '15 300 000 | 52 | нет | 15 300 000')),
    ['Аналог 3 из дела (domclick.ru): цена 15 000 000 руб. в отчёте не найдена — проверьте цену в таблице аналогов']);
  assert.deepEqual(run(ok.replace('13 775 000', '13 800 000')),
    ['Аналог 2 из дела (avito.ru): цена после корректировок 13 775 000 руб. в отчёте не найдена — проверьте расчёт в таблице']);
  assert.deepEqual(run(ok.replace('| 50,5 |', '| 55,5 |')),
    ['Аналог 1 из дела (cian.ru): площадь 50,5 кв. м в отчёте не найдена — проверьте площадь в таблице аналогов']);
  assert.deepEqual(run(ok.replace('sale__flat__403', 'sale__flat__999')), [
    'Аналог 3 из дела (domclick.ru): ссылки на объявление в отчёте нет — добавьте его в таблицу аналогов или уберите из дела',
    'Ссылка у аналога № 3 в отчёте — не из аналогов дела: добавьте объявление в раздел «Аналоги» (ссылка и скриншот со временем) или проверьте ссылку',
  ]);
  assert.deepEqual(run(`${ok}\nАналог 4 — https://www.cian.ru/sale/flat/404/ — 14 800 000 руб.`), [
    'В отчёте есть аналог № 4, а в деле подтверждено 3 аналога — добавьте недостающие в раздел «Аналоги» или проверьте нумерацию',
    'Ссылка у аналога № 4 в отчёте — не из аналогов дела: добавьте объявление в раздел «Аналоги» (ссылка и скриншот со временем) или проверьте ссылку',
  ]);
  assert.deepEqual(run('ОТЧЁТ ОБ ОЦЕНКЕ\nЗатратный подход. Рыночная стоимость 14 000 000 руб.'),
    ['В деле подтверждено 3 аналога, а в отчёте аналогов нет — вставьте таблицу аналогов (кнопка «Отчёт Word» соберёт её сама)']);
  assert.deepEqual(run('ОТЧЁТ\nСравнительный подход не применялся: аналог №1 найден один, предложений недостаточно.'), [], 'сравнительный отвергнут — молчим');
  // Ссылка на закон далеко от «Аналог № N» — не находка; цена «14,5 млн» считается.
  const far = ok.replace('14 500 000 | 51', '14,5 млн | 51') + `\n${'Текст раздела. '.repeat(30)}\nСм. https://www.consultant.ru/document/cons_doc_LAW_19586/`;
  assert.deepEqual(run(far), []);
});

test('2.60: правила подключены — госномер и пробег к транспорту, веса к подходам, аналоги к аналогам', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  const auto = (svc, id) => reg.checks('expertise', svc).find((c) => c.id === id)?.auto ?? [];
  assert.ok(auto('vehicle', 'vehicle_identity').includes('reg_match') && auto('vehicle', 'vehicle_identity').includes('mileage_match'));
  for (const svc of ['vehicle', 'movable', 'realty', 'land']) {
    assert.ok(auto(svc, 'approaches').includes('approach_weights'), svc);
    assert.ok(auto(svc, 'analogs').includes('analog_list') && auto(svc, 'analogs').includes('analog_match'), svc);
  }
});

test('товароведческая (2.61): дата и цена покупки — как в заявке; стоимость ремонта и дата осмотра — не находка', () => {
  assert.deepEqual(purchaseOf('12.03.2026, М.Видео, 54 990 ₽'), { date: '2026-03-12', price: 54990 });
  assert.deepEqual(purchaseOf('куплен 5.1.26 в магазине «Техника-1» за 129990'), { date: '2026-01-05', price: 129990 });
  const fields = { purchase: '12.03.2026, М.Видео, 54 990 ₽' };
  const page = [
    'Объект исследования: холодильник Север-100, серийный номер 0000-0001.',
    'Товар приобретён 12.03.2026 в магазине «Магазин-1», цена по чеку 54 990,00 руб.',
    'Осмотр проведён 01.10.2026. Стоимость устранения недостатка (замена компрессора) — 18 500 руб.',
  ].join('\n');
  assert.deepEqual(runAutoChecks(['purchase_match'], [doc([page])], { fields }).purchase_match, []);
  const bad = page.replace('приобретён 12.03.2026', 'приобретён 21.03.2025').replace('54 990,00 руб', '45 990 руб');
  assert.deepEqual(texts(runAutoChecks(['purchase_match'], [doc([bad])], { fields }), 'purchase_match'), [
    'Дата покупки 21.03.2025 не совпадает с датой из заявки (12.03.2026) — проверьте чек',
    'Цена покупки 45 990 ₽ не совпадает с ценой по чеку из заявки (54 990 ₽) — проверьте чек',
  ]);
  assert.deepEqual(runAutoChecks(['purchase_match'], [doc([bad])], { fields: {} }).purchase_match, [], 'в заявке нет — не сверяем');
});

test('все виды (2.61): каждый вопрос заявки найден в выводах — по номеру или по словам вопроса', () => {
  const q = '1. Имеются ли в холодильнике недостатки?\n2) Каков характер недостатков — производственный или эксплуатационный?\n3. Какова стоимость устранения недостатков?';
  assert.equal(questionsOf(q).length, 3);
  assert.equal(questionsOf('Есть ли трещина в стене дома? Когда она образовалась по времени?').length, 2);
  const fields = { questions: q };
  const body = [
    'ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 10/2026',
    'СОДЕРЖАНИЕ',
    '7. ВЫВОДЫ ........................................ 12',
    'Исследование: компрессор холодильника не запускается.',
  ].join('\n');
  const good = [
    '7. ВЫВОДЫ',
    'По вопросу № 1: в холодильнике имеется недостаток — компрессор не запускается.',
    'Характер недостатка производственный, следов неправильной эксплуатации нет.',
    'По третьему: стоимость устранения недостатка — 18 500 руб.',
  ].join('\n');
  assert.deepEqual(runAutoChecks(['questions_answered'], [doc([body, good])], { fields }).questions_answered, []);
  const partial = good.split('\n').slice(0, 3).join('\n');
  const res = runAutoChecks(['questions_answered'], [doc([body, partial])], { fields });
  assert.deepEqual(texts(res, 'questions_answered'), ['Вопрос 3 из заявки не найден в выводах: «Какова стоимость устранения недостатков?» — дайте ответ или укажите, почему ответить нельзя']);
  assert.equal(res.questions_answered[0].where, 'стр. 2');
  assert.deepEqual(texts(runAutoChecks(['questions_answered'], [doc([body])], { fields }), 'questions_answered'),
    ['В заключении не найден раздел «Выводы» — в заявке вопросов: 3, на каждый нужен ответ'], 'в оглавлении «Выводы» есть, а раздела нет');
  assert.deepEqual(runAutoChecks(['questions_answered'], [doc([body, partial])], { fields: {} }).questions_answered, [], 'вопросов в заявке нет — молчим');
});

test('2.61: правила подключены — покупка к «Данные объекта», вопросы к «Даны ответы на все вопросы» у всех видов', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  const auto = (svc, id) => reg.checks('expertise', svc).find((c) => c.id === id)?.auto ?? [];
  assert.ok(auto('goods', 'object_match').includes('purchase_match'));
  for (const svc of ['goods', 'construction', 'handwriting', 'vehicle', 'realty', 'land', 'movable']) {
    assert.ok(auto(svc, 'questions_answered').includes('questions_answered'), svc);
  }
});
