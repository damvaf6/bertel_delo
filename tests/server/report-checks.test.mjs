// Автоматические находки в отчёте (решение Дамира 03.10.2026): ИИ-проверка ловит ошибки, найденные в настоящих отчётах
// об оценке транспорта. Здесь — только обезличенные выдержки: марки, организации, VIN, номера и суммы вымышленные
// (10-й знак VIN сохранён там, где по нему сверяется год). Настоящие отчёты в репозиторий не попадают.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoChecks, vinYears, wordsToNumber, tocEntries, AUTO_CHECKS, purchaseOf, questionsOf, parseAddress } from '../../src/ai/report-checks.mjs';
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

// 2.88: даты по всему отчёту — осмотр не позже составления и в дни фото осмотра в деле, объявления аналогов не позже даты
// оценки (из дела и из таблицы отчёта), срок документов эксперта — на дату составления, написанную и словами.
test('даты по всему отчёту (2.88): осмотр, объявления аналогов, срок полиса на дату отчёта словами', () => {
  const ok = [...FULL, 'Дата осмотра: 14.09.2026. Таблица аналогов.\nАналог № 1: avito.ru/moskva/1, от 10.09.2026\nДата объявления: 01.09.2026'];
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(ok)], { inspectionDays: ['2026-09-14'] }).report_dates, []);
  // Осмотр после составления; фото осмотра в деле сделаны в другие дни.
  const late = [...FULL, 'Осмотр объекта проведён 25.09.2026.'];
  assert.deepEqual(texts(runAutoChecks(['report_dates'], [doc(late)], { inspectionDays: ['2026-09-12', '2026-09-11'] }), 'report_dates'), [
    'Дата осмотра (25.09.2026) позже даты составления отчёта (20.09.2026) — осмотр не может быть после того, как отчёт составлен',
    'Дата осмотра в отчёте — 25.09.2026, а фото осмотра в деле сделаны 11.09.2026, 12.09.2026 — проверьте дату осмотра',
  ]);
  assert.equal(runAutoChecks(['report_dates'], [doc([...late, 'Оценка проведена без осмотра.'])], {}).report_dates.length, 1, '«без осмотра» — дни фото не сверяем');
  // Объявления позже даты оценки: аналог из дела и строка таблицы в отчёте; одна дата — одна находка.
  const ads = [...FULL, 'Таблица аналогов.\nАналог № 1: cian.ru/sale/1, от 18.09.2026\nАналог № 2: auto.ru/cars/2 от 17.09.2026\nДата публикации — 16.09.2026'.replace(/\\n/g, '\n')];
  const analogs = [{ url: 'https://cian.ru/sale/1', fields: { listed_on: '2026-09-18' } }, { url: 'https://avito.ru/x/3', fields: { listed_on: '2026-09-15' } }];
  const r = texts(runAutoChecks(['report_dates'], [doc(ads)], { analogs }), 'report_dates');
  assert.deepEqual(r, [
    'Аналог 1 из дела (cian.ru): объявление от 18.09.2026 — позже даты оценки (15.09.2026); на дату оценки его ещё не было — возьмите другой аналог или проверьте дату',
    'Объявление аналога от 17.09.2026 — позже даты оценки (15.09.2026); на дату оценки его ещё не было — возьмите другой аналог или проверьте дату',
    'Объявление аналога от 16.09.2026 — позже даты оценки (15.09.2026); на дату оценки его ещё не было — возьмите другой аналог или проверьте дату',
  ]);
  // Определение суда «от» после даты оценки — не объявление; без даты оценки (экспертиза) объявления не сверяем.
  assert.deepEqual(runAutoChecks(['report_dates'], [doc([...FULL, 'Определение суда от 18.09.2026'])]).report_dates, []);
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(['ЗАКЛЮЧЕНИЕ ЭКСПЕРТА', 'avito.ru/x от 18.09.2026'])], { analogs }).report_dates, []);
  // Срок полиса — на дату составления, написанную словами (раньше бралась только «20.09.2026»).
  const dossier = { today: '2026-10-07', items: [{ kind: 'policy', kind_name: 'Полис страхования', number: 'П-77', valid_until: '2026-09-30' }] };
  const words = ['ОТЧЁТ ОБ ОЦЕНКЕ\nДата составления отчёта — 20 сентября 2026 г.\nПолис страхования № П-77'.replace(/\\n/g, '\n')];
  assert.deepEqual(runAutoChecks(['dossier_appraiser'], [doc(words)], { dossier }).dossier_appraiser, [], 'на 20 сентября полис ещё действует');
  assert.match(runAutoChecks(['dossier_appraiser'], [doc(words.map((p) => p.replace('20 сентября', '2 октября')))], { dossier }).dossier_appraiser[0].text,
    /действует до 30\.09\.2026, а отчёт составлен 02\.10\.2026 — на дату отчёта срок истёк/);
});

// 2.146: все даты осмотра в отчёте — разные даты в одном отчёте, каждая сверяется с днями фото; день съёмки по часам
// телефона и день получения — оба дни осмотра; «без осмотра», а в деле есть фото осмотра.
test('дата осмотра (2.146): разные даты в отчёте, день съёмки и день получения, «без осмотра» при фото в деле', () => {
  const one = [...FULL, 'Дата осмотра: 14.09.2026.', 'Раздел 5. Осмотр объекта проведён 14 сентября 2026 года.'];
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(one)], { inspectionDays: ['2026-09-14'] }).report_dates, [], 'одна дата цифрами и словами');
  // Снято вечером 13-го, дошло утром 14-го: в отчёте 14-е — тоже день осмотра.
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(one)], { inspectionDays: ['2026-09-13'], inspectionUploadDays: ['2026-09-14'] }).report_dates, []);
  const two = [...FULL, 'Дата осмотра: 14.09.2026.', 'Раздел 5. Осмотр объекта проведён 02.08.2026.'];
  const r = runAutoChecks(['report_dates'], [doc(two)], { inspectionDays: ['2026-09-14'] }).report_dates;
  assert.deepEqual(r.map((f) => f.text), [
    `В отчёте разные даты осмотра: 14.09.2026 (стр. ${FULL.length + 1}), 02.08.2026 (стр. ${FULL.length + 2}) — оставьте одну, верную`,
    'Дата осмотра в отчёте — 02.08.2026, а фото осмотра в деле сделаны 14.09.2026 — проверьте дату осмотра',
  ]);
  assert.equal(r[1].where, `стр. ${FULL.length + 2}`, 'место — там, где чужая дата');
  assert.match(r[1].quote, /02\.08\.2026/);
  // Без фото в деле разные даты — всё равно находка, а сверки с фото нет.
  assert.equal(runAutoChecks(['report_dates'], [doc(two)], {}).report_dates.length, 1);
  // «Без осмотра», а фото осмотра в деле есть.
  const none = [...FULL, 'Оценка проведена без осмотра объекта.'];
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(none)], { inspectionDays: ['2026-09-14'] }).report_dates.map((f) => f.text),
    ['В отчёте сказано «без осмотра», а в деле есть фото осмотра от 14.09.2026 — проверьте, был ли осмотр']);
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(none)], {}).report_dates, [], 'без фото в деле — «без осмотра» не находка');
});

// 2.154: дата составления не позже дня подписи эксперта; файл не подписан — не позже сегодняшнего дня.
test('дата составления (2.154): не позже дня подписи эксперта, без подписи — не позже сегодня', () => {
  const d = { ...doc(FULL), id: 'f1' };
  assert.deepEqual(runAutoChecks(['report_dates'], [d], { signedOn: { f1: '2026-09-20' }, today: '2026-10-10' }).report_dates, [], 'подписан в день составления');
  assert.deepEqual(runAutoChecks(['report_dates'], [d], { today: '2026-09-20' }).report_dates, [], 'не подписан, составлен сегодня');
  const r = runAutoChecks(['report_dates'], [d], { signedOn: { f1: '2026-09-18' }, today: '2026-10-10' }).report_dates;
  assert.deepEqual(r.map((f) => f.text), ['Дата составления отчёта (20.09.2026) позже дня, когда эксперт подписал файл (18.09.2026), — отчёт подписан раньше, чем составлен; исправьте дату и подпишите файл заново']);
  assert.match(r[0].quote, /20\.09\.2026/, 'место — строка с датой составления');
  assert.deepEqual(texts(runAutoChecks(['report_dates'], [d], { signedOn: { other: '2026-09-18' }, today: '2026-09-19' }), 'report_dates'),
    ['Дата составления отчёта (20.09.2026) ещё не наступила (сегодня 19.09.2026) — подписать отчёт раньше даты составления нельзя; поставьте дату, когда будете подписывать'],
    'подпись другого файла не в счёт');
  const words = [...FULL.map((p) => p.replace('20.09.2026', '25 сентября 2026 г.'))];
  assert.equal(runAutoChecks(['report_dates'], [{ ...doc(words), id: 'f1' }], { signedOn: { f1: '2026-09-21' } }).report_dates.length, 1, 'дата словами');
  assert.deepEqual(runAutoChecks(['report_dates'], [d], {}).report_dates, [], 'без дня подписи и сегодняшнего дня — молчим');
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
    // Список документов заказчика под таблицей задания (2.81): дата — получения файла, не покупки (прогон 2.82).
    'Документы, представленные заказчиком:',
    '2. Чек или договор покупки — файл «Чек.pdf», получен 06.10.2026',
  ].join('\n');
  assert.deepEqual(runAutoChecks(['purchase_match'], [doc([page])], { fields }).purchase_match, []);
  const bad = page.replace('приобретён 12.03.2026', 'приобретён 21.03.2025').replace('54 990,00 руб', '45 990 руб');
  assert.deepEqual(texts(runAutoChecks(['purchase_match'], [doc([bad])], { fields }), 'purchase_match'), [
    'Дата покупки 21.03.2025 не совпадает с датой из заявки (12.03.2026) — проверьте чек',
    'Цена покупки 45 990 ₽ не совпадает с ценой по чеку из заявки (54 990 ₽) — проверьте чек',
  ]);
  assert.deepEqual(runAutoChecks(['purchase_match'], [doc([bad])], { fields: {} }).purchase_match, [], 'в заявке нет — не сверяем');
});

test('адрес объекта (2.94): как в заявке и одинаков по всему отчёту; адреса оценщика, организации и аналогов — не находка', () => {
  assert.deepEqual(parseAddress('г. Москва, ул. Долевая, 3, кв. 8'), { flat: '8', settlement: ['москв'], house: '3', street: ['долев'] });
  assert.deepEqual(parseAddress('Московская обл., г. Одинцово, Можайское шоссе, д. 12, корп. 2, кв. 45'),
    { house: '12', korpus: '2', flat: '45', settlement: ['одинц'], street: ['можай'] });
  assert.deepEqual(parseAddress('МО, д. Тестово, уч. 5'), { plot: '5', settlement: ['тесто'] });
  const fields = { address: 'г. Москва, ул. Долевая, 3, кв. 8' };
  const title = 'ОТЧЁТ ОБ ОЦЕНКЕ квартиры, расположенной по адресу: г. Москва, ул. Долевая, д. 3, кв. 8';
  const good = [
    title,
    'Оценщик Тестов Т. Т., адрес: г. Москва, ул. Офисная, д. 1, оф. 5',
    'Юридический адрес организации: г. Москва, ул. Тверская, д. 10',
    'Адрес объекта оценки: г. Москва, улица Долевая, дом 3, квартира 8. Кадастровый номер 77:01:0001001:1234',
    'Аналог 1 расположен по адресу: г. Москва, ул. Долевая, д. 5, кв. 3',
    'Заказчик зарегистрирован по адресу: г. Москва, ул. Другая, д. 7, кв. 1',
  ].join('\n');
  assert.deepEqual(runAutoChecks(['address_match'], [doc([good])], { fields }).address_match, []);
  const bad = [
    title,
    'Адрес объекта оценки: г. Москва, ул. Долевая, д. 3, кв. 18. Кадастровый номер 77:01:0001001:1234',
    'Местоположение объекта: г. Москва, ул. Садовая, д. 3, кв. 8, общей площадью 54,3 кв. м',
  ];
  const res = runAutoChecks(['address_match'], [doc([bad[0], bad.slice(1).join('\n')])], { fields });
  assert.deepEqual(texts(res, 'address_match'), [
    'Адрес «г. Москва, ул. Долевая, д. 3, кв. 18» не совпадает с адресом из заявки (г. Москва, ул. Долевая, 3, кв. 8): квартира 18, а в заявке 8 — проверьте, нет ли данных другого объекта',
    'Адрес «г. Москва, ул. Садовая, д. 3, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Долевая, 3, кв. 8): другая улица — проверьте, нет ли данных другого объекта',
  ]);
  assert.equal(res.address_match[0].where, 'стр. 2', 'находка — с файлом и страницей');
  // В заявке нет номера дома — номер сверяется по отчёту: на титуле дом 3, в выводах дом 5.
  const loose = runAutoChecks(['address_match'], [doc([
    'Объект расположен по адресу: Московская обл., д. Тестово, ул. Лесная, д. 3',
    'Выводы. Рыночная стоимость жилого дома по адресу: Московская обл., д. Тестово, ул. Лесная, д. 5',
  ])], { fields: { address: 'МО, д. Тестово, ул. Лесная' } });
  assert.deepEqual(texts(loose, 'address_match'), [
    'Адрес «Московская обл., д. Тестово, ул. Лесная, д. 5» не совпадает с адресом объекта на стр. 1: дом 5, а на стр. 1 3 — проверьте, нет ли данных другого объекта',
  ]);
  // Участок: другой номер участка и другая деревня.
  const land = runAutoChecks(['address_match'], [doc(['Местоположение (адрес) участка: Московская обл., д. Иваново, участок № 7'])], { fields: { address: 'МО, д. Тестово, уч. 5' } });
  assert.deepEqual(texts(land, 'address_match'), [
    'Адрес «Московская обл., д. Иваново, участок № 7» не совпадает с адресом из заявки (МО, д. Тестово, уч. 5): другой населённый пункт; участок 7, а в заявке 5 — проверьте, нет ли данных другого объекта',
  ]);
  assert.deepEqual(runAutoChecks(['address_match'], [doc(bad)], { fields: {} }).address_match, [], 'без адреса в заявке — не сверяем');
});

test('адрес объекта (2.167): буква дома, литера, адрес в две строки таблицы и «Адрес (местоположение)»', () => {
  // Буква дома латиницей, через пробел и литерой — тот же дом.
  for (const a of ['г. Москва, ул. Долевая, д. 3А, кв. 8', 'г. Москва, ул. Долевая, д. 3A, кв. 8', 'г. Москва, ул. Долевая, д. 3 А, кв. 8', 'г. Москва, ул. Долевая, д. 3, лит. А, кв. 8']) {
    assert.equal(parseAddress(a).house, '3а', a);
  }
  assert.equal(parseAddress('г. Москва, ул. Долевая, д. 3 в г. Москве').house, '3', 'предлог «в» — не буква дома');
  const fields = { address: 'г. Москва, ул. Долевая, д. 3А, кв. 8' };
  const same = [
    'Адрес объекта оценки: г. Москва, ул. Долевая, д. 3A, кв. 8',
    'Местоположение объекта: г. Москва, ул. Долевая, д. 3, литера А, кв. 8',
    'Адрес объекта: г. Москва, ул. Долевая,',
    'д. 3 А, кв. 8',
  ].join('\n');
  assert.deepEqual(runAutoChecks(['address_match'], [doc([same])], { fields }).address_match, []);
  // Дом без буквы — это другой дом.
  assert.deepEqual(texts(runAutoChecks(['address_match'], [doc(['Адрес объекта оценки: г. Москва, ул. Долевая, д. 3, кв. 8'])], { fields }), 'address_match'), [
    'Адрес «г. Москва, ул. Долевая, д. 3, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Долевая, д. 3А, кв. 8): дом 3, а в заявке 3а — проверьте, нет ли данных другого объекта',
  ]);
  // Адрес в ячейке таблицы разорван без запятой, «Адрес (местоположение):» — раньше не сверялись.
  const res = runAutoChecks(['address_match'], [doc([[
    'Адрес объекта оценки | г. Москва, ул. Долевая',
    'д. 3А, кв. 18',
    'Адрес (местоположение): г. Москва, ул.',
    'Садовая, д. 3А, кв. 8',
  ].join('\n')])], { fields });
  assert.deepEqual(texts(res, 'address_match'), [
    'Адрес «| г. Москва, ул. Долевая д. 3А, кв. 18» не совпадает с адресом из заявки (г. Москва, ул. Долевая, д. 3А, кв. 8): квартира 18, а в заявке 8 — проверьте, нет ли данных другого объекта',
    'Адрес «г. Москва, ул. Садовая, д. 3А, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Долевая, д. 3А, кв. 8): другая улица — проверьте, нет ли данных другого объекта',
  ]);
});

test('2.94: сверка адреса подключена к «Данные объекта» у всех видов', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  for (const svc of ['realty', 'land', 'construction']) {
    assert.ok(reg.checks('expertise', svc).find((c) => c.id === 'object_match').auto.includes('address_match'), svc);
  }
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

test('2.108: итоговая стоимость одна на титуле, в задании, выводах, итоговой таблице и в сопроводительном письме', () => {
  const report = [
    ['ОТЧЁТ ОБ ОЦЕНКЕ № 108/2026', 'Итоговая величина рыночной стоимости объекта оценки составляет 3 000 000 (Три миллиона) рублей'].join('\n'),
    ['Рыночная стоимость 1 кв. м по аналогам — 150 000 руб.', 'Рыночная стоимость, рассчитанная сравнительным подходом, составляет 3 148 760,14 руб.',
      'Итоговая величина рыночной стоимости, руб. 3 000 000'].join('\n'),
    ['ВЫВОДЫ', 'Рыночная стоимость квартиры по адресу: г. Москва, ул. Долевая, д. 3, кв. 8 на 01.10.2026 г. составляет 3 000 тыс. руб.'].join('\n'),
  ];
  const letter = doc(['Сопроводительное письмо', 'Рыночная стоимость объекта оценки составляет 3 000 000,00 руб.'], 'Письмо.pdf');
  assert.deepEqual(runAutoChecks(['final_value'], [doc(report), letter]).final_value, [], 'везде 3 000 000 — находок нет');

  const wrong = doc(['Сопроводительное письмо', 'Рыночная стоимость объекта оценки составляет 3 100 000 руб.'], 'Письмо.pdf');
  const res = runAutoChecks(['final_value'], [wrong, doc(report)]);
  assert.deepEqual(texts(res, 'final_value'), [
    'Итоговая стоимость 3 100 000 руб. не совпадает с 3 000 000 руб. в «Отчёт.pdf» на стр. 1 (и ещё в 2 местах) — сумма должна быть одна во всём отчёте и в письме',
  ]);
  assert.equal(res.final_value[0].file, 'Письмо.pdf');
  assert.equal(res.final_value[0].where, 'стр. 2', 'находка — с файлом и страницей');

  // Выводы расходятся с титулом внутри отчёта.
  const inside = runAutoChecks(['final_value'], [doc([report[0], report[1], report[2].replace('3 000 тыс.', '3 300 000')])]);
  assert.deepEqual(texts(inside, 'final_value'), [
    'Итоговая стоимость 3 300 000 руб. не совпадает с 3 000 000 руб. на стр. 1 (и ещё в 1 месте) — сумма должна быть одна во всём отчёте и в письме',
  ]);
  assert.equal(inside.final_value[0].where, 'стр. 3');

  // Ущерб автомобилю: без износа и с износом — каждая сама с собой; УТС — отдельно.
  const car = [
    'Стоимость восстановительного ремонта без учёта износа составляет 412 300 руб., с учётом износа — 301 900 руб. Утрата товарной стоимости составляет 35 000 руб.',
    'ВЫВОДЫ. Стоимость восстановительного ремонта без учёта износа: 412 300 руб.; стоимость ремонта с учётом износа: 310 900 руб.; УТС — 35 000 руб.',
  ];
  assert.deepEqual(texts(runAutoChecks(['final_value'], [doc(car)]), 'final_value'), [
    'Стоимость ремонта с учётом износа 310 900 руб. не совпадает с 301 900 руб. на стр. 1 — сумма должна быть одна во всём отчёте и в письме',
  ]);

  // Доля и целый объект, с НДС и без, несколько объектов — не сравниваются между собой.
  assert.deepEqual(runAutoChecks(['final_value'], [doc([
    'Рыночная стоимость квартиры составляет 6 000 000 руб. Рыночная стоимость 1/2 доли в праве составляет 2 400 000 руб.',
    'Итоговая величина рыночной стоимости составляет 6 000 000 руб. (с учётом НДС). Рыночная стоимость без учёта НДС составляет 5 000 000 руб.',
  ])]).final_value, []);
  assert.deepEqual(runAutoChecks(['final_value'], [doc([
    'Рыночная стоимость автомобиля 1 составляет 1 200 000 руб.', 'Рыночная стоимость автомобиля 2 составляет 900 000 руб.',
    'Рыночная стоимость автомобиля 3 составляет 700 000 руб.',
  ])]).final_value, [], 'три разные суммы — несколько объектов');
  assert.deepEqual(runAutoChecks(['final_value'], [doc([
    'ВЫВОДЫ. Рыночная стоимость автомобиля 1 составляет 1 200 000 руб. Рыночная стоимость автомобиля 2 составляет 900 000 руб.',
  ])]).final_value, [], 'две суммы на одной странице — два объекта');
});

test('2.108: сверка итоговой стоимости подключена к «Расчёт» у оценки и экспертиз', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  for (const svc of ['realty', 'vehicle', 'car_damage', 'construction']) {
    assert.ok(reg.checks('expertise', svc).find((c) => c.id === 'calculation').auto.includes('final_value'), svc);
  }
});

test('2.116: номер отчёта и дата составления одни на титуле, в колонтитулах и в сопроводительном письме', () => {
  const report = [
    ['ОТЧЁТ ОБ ОЦЕНКЕ № 116/2026-О', 'от «05» октября 2026 г.', 'Дата составления отчёта: 05.10.2026'].join('\n'),
    ['ЗАДАНИЕ НА ОЦЕНКУ', 'Отчёт № 116/2026-О от 05.10.2026 г. Стр. 2'].join('\n'),
    ['ВЫВОДЫ', 'Отчёт № 116/2026-О от 05.10.2026 г. Стр. 3'].join('\n'),
  ];
  const letter = doc(['Исх. № 12 от 05.10.2026', 'Направляем Вам отчёт об оценке № 116 / 2026 - о от 05.10.2026.'], 'Письмо.pdf');
  assert.deepEqual(runAutoChecks(['report_number'], [doc(report), letter]).report_number, [], 'везде один номер и дата — находок нет');

  // В колонтитуле одной страницы — другой номер; в письме — другая дата.
  const footer = [...report, ['ПРИЛОЖЕНИЯ', 'Отчёт № 161/2026-О от 05.10.2026 г. Стр. 4'].join('\n')];
  const late = doc(['Сопроводительное письмо', 'Направляем Вам отчёт об оценке № 116/2026-О от 06.10.2026.'], 'Письмо.pdf');
  const res = runAutoChecks(['report_number'], [late, doc(footer)]);
  assert.deepEqual(texts(res, 'report_number'), [
    'Номер отчёта № 161/2026-О не совпадает с № 116/2026-О на стр. 1 (и ещё в 3 местах) — номер должен быть один на титуле, в колонтитулах и в письме',
    'Дата отчёта 06.10.2026 не совпадает с 05.10.2026 в «Отчёт.pdf» на стр. 1 (и ещё в 3 местах) — дата составления должна быть одна на титуле, в колонтитулах и в письме',
  ]);
  assert.equal(res.report_number[0].where, 'стр. 4', 'находка — с файлом и страницей');
  assert.equal(res.report_number[1].file, 'Письмо.pdf');
  assert.equal(res.report_number[1].quote, 'Направляем Вам отчёт об оценке № 116/2026-О от 06.10.2026.');

  // На титуле дата составления расходится с датой у номера — находка на той же странице.
  const title = runAutoChecks(['report_number'], [doc([report[0].replace('Дата составления отчёта: 05.10.2026', 'Дата составления отчёта: 07.10.2026'), report[1], report[2]])]);
  assert.deepEqual(texts(title, 'report_number'), [
    'Дата отчёта 07.10.2026 не совпадает с 05.10.2026 на стр. 1 (и ещё в 2 местах) — дата составления должна быть одна на титуле, в колонтитулах и в письме',
  ]);

  // Заключение эксперта, «N» вместо «№»; ссылки на прежние отчёты (три номера) и два номера на странице — молчим.
  assert.deepEqual(texts(runAutoChecks(['report_number'], [doc(['ЗАКЛЮЧЕНИЕ ЭКСПЕРТА N 7-С/2026', 'Заключение эксперта № 7-С/2026, стр. 2', 'Заключение № 7-С/2026, стр. 3'])]), 'report_number'), []);
  assert.deepEqual(runAutoChecks(['report_number'], [doc([
    'ОТЧЁТ № 3/2026', 'Ранее объект оценивался: отчёт № 1/2024, отчёт № 2/2025', 'Отчёт № 3/2026',
  ])]).report_number, [], 'три разных номера — ссылки на прежние отчёты');
  assert.deepEqual(runAutoChecks(['report_number'], [doc([
    'ОТЧЁТ № 3/2026', 'Отчёт № 3/2026. Ранее составлен отчёт № 1/2024',
  ])]).report_number, [], 'два номера на одной странице');
});

test('2.123: дата оценки одна по всему отчёту и в сопроводительном письме', () => {
  const report = [
    ['ОТЧЁТ ОБ ОЦЕНКЕ № 123/2026-О', 'Дата оценки (дата определения стоимости): 01.10.2026', 'Дата составления отчёта: 05.10.2026'].join('\n'),
    ['ЗАДАНИЕ НА ОЦЕНКУ', 'Датой оценки является «01» октября 2026 г.'].join('\n'),
    ['ВЫВОДЫ', 'Рыночная стоимость квартиры по адресу: г. Москва, ул. Тестовая, д. 1, кв. 2 по состоянию на 01.10.2026 составляет 9 000 000 руб.',
      'Кадастровая стоимость по состоянию на 01.01.2026 — 7 100 000 руб.; выписка из ЕГРН по состоянию на 20.09.2026.'].join('\n'),
  ];
  const letter = doc(['Сопроводительное письмо', 'Рыночная стоимость объекта оценки по состоянию на 1 октября 2026 г. составляет 9 000 000 руб.'], 'Письмо.pdf');
  assert.deepEqual(runAutoChecks(['value_date'], [doc(report), letter]).value_date, [], 'везде одна дата оценки; кадастровая стоимость и выписка — не в счёт');

  // В письме — другая дата оценки: находка с файлом, страницей и строкой.
  const late = doc(['Сопроводительное письмо', 'Рыночная стоимость объекта оценки по состоянию на 02.10.2026 составляет 9 000 000 руб.'], 'Письмо.pdf');
  const res = runAutoChecks(['value_date'], [late, doc(report)]);
  assert.deepEqual(texts(res, 'value_date'), [
    'Дата оценки 02.10.2026 не совпадает с 01.10.2026 в «Отчёт.pdf» на стр. 1 (и ещё в 2 местах) — дата оценки должна быть одна во всём отчёте и в письме',
  ]);
  assert.equal(res.value_date[0].file, 'Письмо.pdf');
  assert.equal(res.value_date[0].where, 'стр. 2');
  assert.equal(res.value_date[0].quote, 'Рыночная стоимость объекта оценки по состоянию на 02.10.2026 составляет 9 000 000 руб.');

  // В выводах отчёта — другая дата: находка на стр. 3; на титуле две разные даты оценки — находка на той же странице.
  const body = runAutoChecks(['value_date'], [doc([report[0], report[1], report[2].replace('на 01.10.2026', 'на 10.01.2026')]), letter]);
  assert.deepEqual(texts(body, 'value_date'), [
    'Дата оценки 10.01.2026 не совпадает с 01.10.2026 на стр. 1 (и ещё в 2 местах) — дата оценки должна быть одна во всём отчёте и в письме',
  ]);
  assert.equal(body.value_date[0].where, 'стр. 3');
  const title = runAutoChecks(['value_date'], [doc([`${report[0]}\nДата определения стоимости: 03.10.2026`, report[1], report[2]])]);
  assert.deepEqual(texts(title, 'value_date'), [
    'Дата оценки 03.10.2026 не совпадает с 01.10.2026 на стр. 1 (и ещё в 2 местах) — дата оценки должна быть одна во всём отчёте и в письме',
  ]);

  // Прежние оценки, аналоги и три разные даты — молчим; дат оценки нет (товароведческая) — молчим.
  assert.deepEqual(runAutoChecks(['value_date'], [doc([
    'Дата оценки: 01.10.2026', 'Рыночная стоимость по предыдущему отчёту по состоянию на 01.03.2025 составляла 8 000 000 руб.', 'Стоимость аналога № 1 по состоянию на 15.09.2026',
  ])]).value_date, []);
  assert.deepEqual(runAutoChecks(['value_date'], [doc(['Дата оценки: 01.10.2026', 'Дата оценки: 02.10.2026', 'Дата оценки: 03.10.2026'])]).value_date, [], 'три разные даты — не одна дата оценки');
  assert.deepEqual(runAutoChecks(['value_date'], [doc(['ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 7', 'Товар куплен 12.03.2026'])]).value_date, []);
});

test('2.123: сверка даты оценки подключена к «Реквизиты» у всех видов', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  for (const svc of ['realty', 'land', 'vehicle', 'car_damage', 'construction', 'goods']) {
    assert.ok(reg.checks('expertise', svc).find((c) => c.id === 'requisites').auto.includes('value_date'), svc);
  }
});

test('2.116: сверка номера и даты отчёта подключена к «Реквизиты» у всех видов', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  for (const svc of ['realty', 'vehicle', 'car_damage', 'construction', 'goods', 'handwriting']) {
    assert.ok(reg.checks('expertise', svc).find((c) => c.id === 'requisites').auto.includes('report_number'), svc);
  }
});

test('2.131: цель оценки — как в заявке, вид стоимости один по отчёту и подходит к цели', () => {
  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 31/2026\nСодержание\nЗадание на оценку ........ 3',
    'Задание на оценку\nЦель оценки: определение рыночной стоимости для совершения нотариальных действий по наследственному делу.\nВид определяемой стоимости — рыночная.\nДата оценки: 01.10.2026',
    'Выводы\nРыночная стоимость квартиры составляет 9 000 000 руб.',
  ];
  const letter = doc(['Сопроводительное письмо', 'Вид стоимости: рыночная. Цель оценки — для нотариуса.'], 'Письмо.pdf');
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(report), letter], { fields: { purpose: 'inheritance' }, service: 'realty' }).purpose_value, [], 'цель и вид как в заявке');

  // В письме осталась цель из шаблона банка: находка с файлом, страницей и строкой.
  const bankLetter = doc(['Сопроводительное письмо', 'Цель оценки: для предоставления в банк в качестве залога.'], 'Письмо.pdf');
  const res = runAutoChecks(['purpose_value'], [doc(report), bankLetter], { fields: { purpose: 'inheritance' }, service: 'realty' });
  assert.deepEqual(texts(res, 'purpose_value'), [
    'Цель оценки в отчёте — «для предоставления в банк в качестве залога» (ипотека, залог, банк), а в заявке — «наследство, нотариус»: цель должна быть как в заявке',
  ]);
  assert.equal(res.purpose_value[0].file, 'Письмо.pdf');
  assert.equal(res.purpose_value[0].where, 'стр. 2');
  assert.equal(res.purpose_value[0].quote, 'Цель оценки: для предоставления в банк в качестве залога.');

  // Совместимые цели не в счёт: раздел имущества через суд; ипотека при покупке; цель без признаков и «другое» — молчим.
  const court = [report[0], report[1].replace(/для совершения[^.]+/u, 'для представления в суд по делу о разделе совместно нажитого имущества'), report[2]];
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(court)], { fields: { purpose: 'division' } }).purpose_value, []);
  const loan = [report[0], report[1].replace(/для совершения[^.]+/u, 'для ипотечного кредитования'), report[2]];
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(loan)], { fields: { purpose: 'deal' } }).purpose_value, []);
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(loan)], { fields: { purpose: 'other' } }).purpose_value, []);
  const plain = [report[0], report[1].replace(/для совершения[^.]+/u, 'для принятия управленческих решений'), report[2]];
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(plain)], { fields: { purpose: 'court' } }).purpose_value, []);

  // В выводах другой вид стоимости, чем в задании и в письме: находка на стр. 3.
  const odd = [report[0], report[1], `${report[2]}\nВид стоимости: ликвидационная`];
  const kind = runAutoChecks(['purpose_value'], [doc(odd), letter], { fields: { purpose: 'inheritance' } });
  assert.deepEqual(texts(kind, 'purpose_value'), [
    'Вид стоимости «ликвидационная» не совпадает с «рыночная» на стр. 2 (и ещё в 1 месте) — вид стоимости должен быть один во всём отчёте и в письме',
  ]);
  assert.equal(kind.purpose_value[0].where, 'стр. 3');

  // Для банка рыночная и ликвидационная вместе — норма.
  const bank = [report[0], 'Задание на оценку\nЦель оценки: для залога в банке.\nВид стоимости: рыночная и ликвидационная.', 'Выводы\nВид стоимости: рыночная\nВид стоимости: ликвидационная'];
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(bank)], { fields: { purpose: 'bank' } }).purpose_value, []);

  // Для нотариуса — только ликвидационная: нужна рыночная.
  const liq = [report[0], report[1].replace('рыночная.', 'ликвидационная.'), report[2]];
  assert.deepEqual(texts(runAutoChecks(['purpose_value'], [doc(liq)], { fields: { purpose: 'inheritance' } }), 'purpose_value'), [
    'В отчёте вид стоимости — «ликвидационная», а для цели заявки «наследство, нотариус» нужна рыночная стоимость',
  ]);

  // Не оценка (строительная экспертиза) — молчим; строка оглавления — не цель.
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(liq)], { fields: { purpose: 'inheritance' }, service: 'construction' }).purpose_value, []);
  assert.deepEqual(runAutoChecks(['purpose_value'], [doc(['Содержание\nЦель оценки для банка ........ 4'])], { fields: { purpose: 'court' } }).purpose_value, []);
});

test('2.131: сверка цели и вида стоимости подключена к оценке', async () => {
  const { createRegistry } = await import('../../src/modules/index.mjs');
  const reg = createRegistry();
  for (const svc of ['realty', 'land', 'vehicle', 'movable']) {
    assert.ok(reg.checks('expertise', svc).find((c) => c.id === 'appraiser').auto.includes('purpose_value'), svc);
  }
});
