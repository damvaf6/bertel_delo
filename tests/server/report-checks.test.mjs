// Автоматические находки в отчёте (решение Дамира 03.10.2026): ИИ-проверка ловит ошибки, найденные в настоящих отчётах
// об оценке транспорта. Здесь — только обезличенные выдержки: марки, организации, VIN, номера и суммы вымышленные
// (10-й знак VIN сохранён там, где по нему сверяется год). Настоящие отчёты в репозиторий не попадают.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoChecks, vinYears, wordsToNumber, numberToWords, tocEntries, AUTO_CHECKS, purchaseOf, questionsOf, parseAddress, parseFloorField } from '../../src/ai/report-checks.mjs';
import { pagesForModel } from '../../src/ops/ai-ops.mjs';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { makePdf } from '../tools/make-docs.mjs';
import { swapValue } from '../../public/draftfind.js';

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
    'Дата оценки (15.09.2026) раньше даты осмотра (25.09.2026) — если оценка ретроспективная, напишите это и допущение, что состояние объекта на дату оценки такое же, как на дату осмотра; иначе исправьте дату',
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

// 2.298: дата составления отчёта не раньше даты самого задания на оценку (письма заказчика, определения суда) из дела.
test('2.298: дата составления отчёта не раньше даты задания на оценку', () => {
  const run = (...assignment) => runAutoChecks(['report_dates'], [doc(FULL)], { assignment }).report_dates;
  const task = (head, name = 'Задание.pdf') => doc([`${head}\nДата оценки: 15.09.2026\nСрок составления отчёта: не позднее 30.09.2026`], name);
  // Задание раньше составления или в тот же день — молчим.
  assert.deepEqual(run(task('ЗАДАНИЕ НА ОЦЕНКУ № 5 от 10.09.2026')), []);
  assert.deepEqual(run(task('ЗАДАНИЕ НА ОЦЕНКУ № 5 от «20» сентября 2026 г.')), [], 'тот же день, словами');
  // Задание позже составления — находка у даты составления.
  const r = run(task('ЗАДАНИЕ НА ОЦЕНКУ № 5 от 22.09.2026'));
  assert.deepEqual(r.map((f) => f.text), ['Дата составления отчёта (20.09.2026) раньше даты задания на оценку «Задание.pdf» (22.09.2026, стр. 1) — отчёт не может быть составлен раньше, чем дано задание; исправьте дату составления или приложите к делу верный документ']);
  assert.match(r[0].quote, /Дата составления отчёта: 20\.09\.2026/);
  // «Дата задания», письмо с исходящим номером, определение суда с датой в шапке — со своим названием.
  assert.equal(run(task('ЗАДАНИЕ НА ОЦЕНКУ\nДата задания: 25.09.2026')).length, 1);
  assert.match(run(doc(['ООО «Банк-Тест»\nИсх. № 15 от 3 октября 2026 г.\nПрошу определить рыночную стоимость квартиры по состоянию на 15.09.2026.'], 'Письмо банка.pdf'))[0].text,
    /раньше даты письма заказчика «Письмо банка\.pdf» \(03\.10\.2026, стр\. 1\) — отчёт не может быть составлен раньше, чем написано письмо/);
  // Прогон 2.300: тот же файл, приложенный к просьбе «Задание на оценку от банка» (`asked`), — задание, не письмо заказчика.
  assert.match(run({ ...doc(['ООО «Банк-Тест»\nИсх. № 15 от 3 октября 2026 г.\nПрошу определить рыночную стоимость квартиры.'], 'скан.pdf'), asked: true })[0].text,
    /раньше даты задания на оценку «скан\.pdf» \(03\.10\.2026, стр\. 1\) — отчёт не может быть составлен раньше, чем дано задание/);
  assert.match(run(doc(['ОПРЕДЕЛЕНИЕ\n«21» сентября 2026 года г. Москва\nо назначении судебной экспертизы'], 'Определение.pdf'))[0].text,
    /раньше даты определения суда «Определение\.pdf» \(21\.09\.2026, стр\. 1\) — отчёт не может быть составлен раньше, чем вынесено определение/);
  // Дата оценки, срок отчёта и даты ниже шапки — не дата задания; даты нет — молчим.
  assert.deepEqual(run(doc(['ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: 25.09.2026\nСрок: до 30.09.2026'], 'Задание.pdf')), []);
  assert.deepEqual(run(doc([['ЗАДАНИЕ НА ОЦЕНКУ', ...Array(12).fill('Объект оценки: квартира'), 'Договор № 9 от 25.09.2026'].join('\n')], 'Задание.pdf')), []);
  // Старое и новое задание — по самому раннему: отчёт после старого не находка.
  assert.deepEqual(run(task('ЗАДАНИЕ НА ОЦЕНКУ № 5 от 10.09.2026'), task('ЗАДАНИЕ НА ОЦЕНКУ № 6 от 25.09.2026', 'Задание-2.pdf')), []);
  // Без даты составления в отчёте — молчим.
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(FULL.map((p) => p.replace(/Дата составления отчёта: 20\.09\.2026\n/, '')))], { assignment: [task('ЗАДАНИЕ НА ОЦЕНКУ № 5 от 22.09.2026')] }).report_dates, []);
});

// 2.302: дата составления отчёта не позже срока из задания на оценку («не позднее …», «срок составления отчёта …»).
test('2.302: дата составления отчёта не позже срока из задания на оценку', () => {
  const run = (...assignment) => runAutoChecks(['report_dates'], [doc(FULL)], { assignment }).report_dates;
  const task = (line, name = 'Задание.pdf') => doc([`ЗАДАНИЕ НА ОЦЕНКУ № 5 от 10.09.2026\nДата оценки: 15.09.2026\n${line}`], name);
  // В срок или в последний день — молчим.
  assert.deepEqual(run(task('Срок составления отчёта: не позднее 30.09.2026')), []);
  assert.deepEqual(run(task('Отчёт представить до «20» сентября 2026 г.')), [], 'последний день, словами');
  // Позже срока — находка у даты составления.
  const r = run(task('Срок составления отчёта: не позднее 18.09.2026'));
  assert.deepEqual(r.map((f) => f.text), ['Дата составления отчёта (20.09.2026) позже срока из задания на оценку «Задание.pdf» (не позднее 18.09.2026, стр. 1) — отчёт составлен после срока; проверьте дату составления, а если срок переносили — приложите к делу документ о переносе']);
  assert.match(r[0].quote, /Дата составления отчёта: 20\.09\.2026/);
  // Разные формулировки срока; определение суда — со своим названием.
  assert.equal(run(task('Срок: до 19.09.2026')).length, 1);
  assert.equal(run(task('Срок проведения оценки — 19 сентября 2026 г.')).length, 1);
  assert.match(run(doc(['ОПРЕДЕЛЕНИЕ\n«01» сентября 2026 года г. Москва\nо назначении судебной экспертизы\nПровести экспертизу в срок до 15.09.2026'], 'Определение.pdf'))[0].text,
    /позже срока из определения суда «Определение\.pdf» \(не позднее 15\.09\.2026, стр\. 1\)/);
  // Оплата, дата оценки, выписка, срок действия договора и «по состоянию на» — не срок отчёта.
  for (const line of ['Оплата не позднее 15.09.2026', 'Оценку провести по состоянию на 15.09.2026', 'Выписка ЕГРН не позднее 01.09.2026',
    'Срок действия договора — до 01.09.2026', 'Срок составления отчёта: 10 рабочих дней с 01.09.2026']) {
    assert.deepEqual(run(task(line)), [], line);
  }
  // Старое задание с ранним сроком и новое с перенесённым — по самому позднему.
  assert.deepEqual(run(task('Срок: не позднее 18.09.2026'), task('Срок: не позднее 25.09.2026', 'Задание-2.pdf')), []);
  // Без даты составления в отчёте и без срока в задании — молчим.
  assert.deepEqual(runAutoChecks(['report_dates'], [doc(FULL.map((p) => p.replace(/Дата составления отчёта: 20\.09\.2026\n/, '')))], { assignment: [task('Срок: до 18.09.2026')] }).report_dates, []);
  assert.deepEqual(run(task('Объект оценки: квартира')), []);
});

// 2.345: срок по заданию взят из письма о переносе срока (2.333) — находка называет письмо и прежний срок, совет — попросить
// письмо с новым сроком, а не «приложите документ о переносе».
test('2.345: дата составления позже срока из письма о переносе — находка называет письмо', () => {
  const run = (...assignment) => runAutoChecks(['report_dates'], [doc(FULL)], { assignment }).report_dates.map((f) => f.text);
  const task = (line, name = 'Задание.pdf', more = {}) => ({ ...doc([`ЗАДАНИЕ НА ОЦЕНКУ № 5 от 10.09.2026\nДата оценки: 15.09.2026\n${line}`], name), ...more });
  const letter = (line, name = 'Письмо банка.pdf', more = {}) => ({ ...doc([`Сообщаем, что ${line}`], name), ...more });
  // Задание с ранним сроком и письмо с сроком тоже раньше даты составления — письмо и прежний срок.
  assert.deepEqual(run(task('Срок: не позднее 15.09.2026'), letter('срок составления отчёта продлён: не позднее 18.09.2026')),
    ['Дата составления отчёта (20.09.2026) позже срока из письма о переносе срока «Письмо банка.pdf» (не позднее 18.09.2026, стр. 1) — срок переносили письмом (по заданию было 15.09.2026), но отчёт составлен и после нового срока; проверьте дату составления или попросите у заказчика письмо с новым сроком']);
  // Письмо приложено к просьбе «Письмо банка о переносе» (moved), в задании срока нет — без прежнего срока.
  assert.deepEqual(run(task('Объект оценки: квартира'), letter('срок составления отчёта продлён: не позднее 18.09.2026', 'скан.pdf', { moved: true })),
    ['Дата составления отчёта (20.09.2026) позже срока из письма о переносе срока «скан.pdf» (не позднее 18.09.2026, стр. 1) — срок переносили письмом, но отчёт составлен и после нового срока; проверьте дату составления или попросите у заказчика письмо с новым сроком']);
  // Два письма — прежний срок «по прежнему письму».
  assert.match(run(task('Срок: не позднее 12.09.2026'), letter('срок составления отчёта продлён: не позднее 15.09.2026', 'Письмо-1.pdf'), letter('срок составления отчёта продлён: не позднее 18.09.2026', 'Письмо-2.pdf'))[0],
    /«Письмо-2\.pdf» \(не позднее 18\.09\.2026, стр\. 1\) — срок переносили письмом \(по прежнему письму было 15\.09\.2026\)/);
  // По письму в срок — молчим; одно задание без письма — прежний текст.
  assert.deepEqual(run(task('Срок: не позднее 15.09.2026'), letter('срок составления отчёта продлён: не позднее 25.09.2026')), []);
  assert.match(run(task('Срок: не позднее 18.09.2026'))[0], /позже срока из задания на оценку «Задание\.pdf».*приложите к делу документ о переносе$/);
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

// 2.175: дата оценки не позже дня подписи (без даты составления; с ней — date_order и 2.154) и не раньше осмотра,
// если не сказано, что оценка ретроспективная или что состояние на дату оценки — как на дату осмотра.
test('дата оценки (2.175): не позже подписи, не раньше осмотра без ретроспективы', () => {
  const noMade = FULL.map((p) => p.replace('Дата составления отчёта: 20.09.2026\n', ''));
  const d = { ...doc(noMade), id: 'f1' };
  assert.deepEqual(runAutoChecks(['report_dates'], [d], { signedOn: { f1: '2026-09-15' } }).report_dates, [], 'подписан в день оценки');
  assert.deepEqual(texts(runAutoChecks(['report_dates'], [d], { signedOn: { f1: '2026-09-14' } }), 'report_dates'),
    ['Дата оценки (15.09.2026) позже дня, когда эксперт подписал файл (14.09.2026), — оценить на дату, которая ещё не наступила, нельзя; исправьте дату и подпишите файл заново']);
  const r = runAutoChecks(['report_dates'], [d], { today: '2026-09-10' }).report_dates;
  assert.deepEqual(r.map((f) => f.text), ['Дата оценки (15.09.2026) ещё не наступила (сегодня 10.09.2026) — оценить на будущую дату нельзя; проверьте дату оценки']);
  assert.match(r[0].quote, /Дата оценки: 15\.09\.2026/, 'место — строка с датой оценки');
  // С датой составления — одна находка от 2.154, без повтора про дату оценки.
  assert.equal(runAutoChecks(['report_dates'], [{ ...doc(FULL), id: 'f1' }], { signedOn: { f1: '2026-09-14' } }).report_dates.length, 1);

  const late = [...FULL, 'Дата осмотра: 17.09.2026.'];
  assert.deepEqual(texts(runAutoChecks(['report_dates'], [doc(late)], {}), 'report_dates'),
    ['Дата оценки (15.09.2026) раньше даты осмотра (17.09.2026) — если оценка ретроспективная, напишите это и допущение, что состояние объекта на дату оценки такое же, как на дату осмотра; иначе исправьте дату']);
  assert.deepEqual(runAutoChecks(['report_dates'], [doc([...late, 'Оценка ретроспективная.'])], {}).report_dates, [], 'ретроспективная оценка');
  assert.deepEqual(runAutoChecks(['report_dates'], [doc([...late,
    'Допущение: состояние объекта на дату оценки соответствует его состоянию на дату осмотра.'])], {}).report_dates, [], 'допущение о состоянии');
  assert.deepEqual(runAutoChecks(['report_dates'], [doc([...FULL, 'Осмотр объекта проведён 15 сентября 2026 г.'])], {}).report_dates, [], 'осмотр в день оценки');
  assert.deepEqual(runAutoChecks(['report_dates'], [doc([...FULL, 'Дата осмотра: 12.09.2026.'])], {}).report_dates, [], 'осмотр до даты оценки');
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

test('2.364: итоговая стоимость прописью — «руб.» перед скобкой, рубли и копейки в скобках, копейки после скобки', () => {
  assert.equal(numberToWords(0), 'ноль');
  assert.equal(numberToWords(2001), 'две тысячи один');
  assert.equal(numberToWords(101_001), 'сто одна тысяча один');
  assert.equal(numberToWords(2_456_214), 'два миллиона четыреста пятьдесят шесть тысяч двести четырнадцать');
  assert.equal(numberToWords(1_000_000_000), 'один миллиард');
  const res = runAutoChecks(['sum_words'], [doc([
    'Итоговая рыночная стоимость объекта составляет 2 500 000 руб. (два миллиона рублей 00 копеек).',
    'составляет 3 148 760,14 руб. (Три миллиона сто сорок восемь тысяч семьсот шестьдесят рублей 41 копейка)',
    'составляет 3 000 000 руб. (три миллиона рублей 00 копеек); 1 200 000,50 (Один миллион двести тысяч) руб. 50 коп.',
    'составляет 7 000 000,00 (Семь миллионов) рублей 00 копеек; 5 000 000 руб. (Пять миллионов рублей ноль копеек)',
  ])]);
  assert.deepEqual(texts(res, 'sum_words'), [
    'Итоговая стоимость: сумма цифрами 2 500 000 не совпадает с суммой прописью (2 000 000) — цифрам соответствует «два миллиона пятьсот тысяч»',
    'Сумма цифрами 3 148 760,14 не совпадает с суммой прописью (3 148 760,41)',
  ], 'совпадающие суммы (в том числе с копейками после скобки) — без находок');
  assert.deepEqual(res.sum_words[0].words, { bad: 'два миллиона', right: 'два миллиона пятьсот тысяч' });
  assert.equal(res.sum_words[1].words, undefined, 'рубли совпали — менять словами нечего');
});

test('сумма цифрами и прописью; числа прописью; год по VIN; оглавление с переносами', () => {
  assert.equal(wordsToNumber('Девять миллионов семьсот тысяч'), 9_700_000);
  assert.equal(wordsToNumber('Два миллиона четыреста пятьдесят шесть тысяч двести четырнадцать'), 2_456_214);
  assert.equal(wordsToNumber('Одна тысяча'), 1000);
  assert.equal(wordsToNumber('сто рублей'), 100);
  assert.equal(wordsToNumber('много денег'), null);
  const res = runAutoChecks(['sum_words'], [doc(['Итог: 4 100 000,00 = (Четыре миллиона сто тысяч) рублей', 'составляет 3 500 000 (Три миллиона семьсот тысяч) рублей'])]);
  assert.deepEqual(texts(res, 'sum_words'), ['Сумма цифрами 3 500 000 не совпадает с суммой прописью (3 700 000) — цифрам соответствует «Три миллиона пятьсот тысяч»']);
  assert.equal(res.sum_words[0].where, 'стр. 2');
  assert.deepEqual(res.sum_words[0].words, { bad: 'Три миллиона семьсот тысяч', right: 'Три миллиона пятьсот тысяч' });
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

test('этаж и этажность (2.187): «этаж 3 из 9», «3/9 эт.», «Этаж: 3/9» — сверяются; магазин на 1 этаже и подземные этажи — не находка', () => {
  assert.deepEqual(['5 / 9', '5/9', '5 из 9', '5 этаж из 9', '5-й этаж из 9', '5'].map(parseFloorField),
    [...Array(5).fill({ floor: 5, floors: 9 }), { floor: 5, floors: null }]);
  assert.equal(parseFloorField('цоколь'), null);
  const same = [
    'Квартира расположена на этаже 3 из 9',
    'Этаж: 3/9; этаж 3 из 9',
    'Квартира 3/9 эт. панельного дома, на 3-м этаже из 9',
    'Этаж/этажей в доме: 3/9',
    'Этаж / этажность дома: 3 / 9',
    'Квартира расположена на 3 этаже 9-этажного жилого дома, на этаже 3 9-этажного дома',
    'Количество подземных этажей: 1',
    'Этажность: 9, в т.ч. подземных 1, цокольных этажей: 1',
    'На 1 этаже дома расположен магазин',
    'Аналог 2: квартира 7/12 эт.',
  ].join('\n');
  for (const floor of ['3 / 9', '3 из 9', '3 этаж из 9']) {
    assert.deepEqual(runAutoChecks(['floor_match'], [doc([same])], { fields: { floor }, service: 'realty' }).floor_match, [], floor);
  }
  const other = ['Этаж 4 из 9', 'Этаж: 3/10', '6/9 эт.'].join('\n');
  assert.deepEqual(texts(runAutoChecks(['floor_match'], [doc([other])], { fields: { floor: '3 из 9' }, service: 'realty' }), 'floor_match'), [
    'Этаж 4 не совпадает с этажом из заявки (3) — проверьте, нет ли данных другого объекта',
    'Этажей в доме 10, а в заявке 9 — проверьте, нет ли данных другого дома',
    'Этаж 6 не совпадает с этажом из заявки (3) — проверьте, нет ли данных другого объекта',
  ]);
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

test('площадь (2.174): погрешность из ЕГРН, единица перед числом, перенос строки, части квартиры, «0,1200 га»', () => {
  const area = (lines, ctx) => texts(runAutoChecks(['area_match'], [doc([lines.join('\n')])], ctx), 'area_match');
  const flat = { fields: { area: 54.3, object_type: 'flat' }, service: 'realty' };
  const land = { fields: { area: 1200 }, service: 'land' };
  const wrong = (v, mine) => [`Площадь ${v} кв. м не совпадает с площадью из заявки (${mine} кв. м) — проверьте, нет ли данных другого объекта`];
  // Ложные находки прежней проверки — теперь их нет.
  assert.deepEqual(area(['Площадь: 1200 +/- 12 кв. м', 'Площадь участка 1200 ± 12 кв.м', 'Площадь участка 0,1200 га'], land), []);
  assert.deepEqual(area(['Общая площадь 54,3 кв. м, в том числе площадь комнат 36,2 кв. м, площадь санузла 4 кв. м, площадь коридора 6 кв. м'], flat), []);
  assert.deepEqual(area(['Общая площадь, кв. м: 54,3', 'Площадь кухни, кв. м: 9'], flat), []);
  // Пропуски прежней проверки — теперь находка.
  assert.deepEqual(area(['Общая площадь, кв. м: 45,1'], flat), wrong('45,1', '54,3'));
  assert.deepEqual(area(['Площадь (кв. м) 45,1'], flat), wrong('45,1', '54,3'));
  assert.deepEqual(area(['Квартира общей площадью', '45,1 кв. м'], flat), wrong('45,1', '54,3'));
  assert.deepEqual(area(['Общая площадь 45,1 м 2'], flat), wrong('45,1', '54,3'));
  assert.deepEqual(area(['Площадь кухни 8 кв. м, общая площадь 45,1 кв. м'], flat), wrong('45,1', '54,3'));
  assert.deepEqual(area(['Площадь: 1500 +/- 14 кв. м'], land), wrong('1 500', '1 200'));
  // Комната: площадь квартиры — не находка, другая площадь комнаты — находка.
  const room = { fields: { area: 18.2, object_type: 'room' }, service: 'realty' };
  assert.deepEqual(area(['Комната площадью 18,2 кв. м в квартире общей площадью 60 кв. м'], room), []);
  assert.deepEqual(area(['Комната площадью 17 кв. м'], room), wrong('17', '18,2'));
});

test('недвижимость и земля (2.59): новые правила подключены к проверке «Адрес, кадастровый номер, площадь»', async () => {
  const { DEFAULT_MODULES } = await import('../../src/modules/index.mjs');
  const exp = DEFAULT_MODULES.find((m) => m.id === 'expertise');
  const rule = exp.checks.find((c) => c.id === 'realty_identity');
  assert.deepEqual(rule.auto, ['cadastral_match', 'area_match', 'floor_match', 'building_match', 'use_match', 'room_kind_match', 'cad_value_match', 'share_match', 'egrn_doc_match', 'land_match']);
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

test('2.184: аналоги в отчёте — у каждого номера своя цена и своя ссылка', () => {
  const analogs = [
    { url: 'https://www.cian.ru/sale/flat/401/', fields: { price_rub: 14000000, area: 50.5 }, adjustments: [] },
    { url: 'https://www.avito.ru/moskva/kvartiry/402', fields: { price_rub: 14500000, area: 51 }, adjustments: [{ kind: 'bargain', pct: -5 }] },
    { url: 'https://domclick.ru/card/sale__flat__403', fields: { price_rub: 15000000, area: 52 }, adjustments: [] },
  ];
  const head = '| № | Источник | Цена, руб. | Площадь, кв. м | Корректировки, всего | Цена после корректировок, руб. |';
  const rows = [
    '| 1 | cian.ru | 14 000 000 | 50,5 | нет | 14 000 000 |',
    '| 2 | avito.ru | 14 500 000 | 51 | −5 % | 13 775 000 |',
    '| 3 | domclick.ru | 15 000 000 | 52 | нет | 15 000 000 |',
  ];
  const links = ['Аналог 1 — cian.ru', 'Ссылка: https://www.cian.ru/sale/flat/401/', 'Аналог 2 — avito.ru',
    'Ссылка: https://www.avito.ru/moskva/kvartiry/402', 'Аналог 3 — domclick.ru', 'Ссылка: https://domclick.ru/card/sale__flat__403'];
  const report = (r = rows, l = links, extra = []) => ['ОТЧЁТ ОБ ОЦЕНКЕ № 7/2026', 'Сравнительный подход', head, ...r, ...extra,
    'Приложение. Скриншоты объявлений (аналоги)', ...l].join('\n');
  const run = (text) => texts(runAutoChecks(['analog_match'], [doc([text])], { analogs }), 'analog_match');
  assert.deepEqual(run(report()), [], 'всё по своим местам');
  // Строки 1 и 3 переставлены цифрами: у № 1 — цена аналога 3, у № 3 — цена аналога 1.
  const swapped = [rows[0].replace(/14 000 000/g, '15 000 000'), rows[1], rows[2].replace(/15 000 000/g, '14 000 000')];
  assert.deepEqual(run(report(swapped)), [
    'У аналога № 1 в таблице отчёта цена 15 000 000 руб. — это цена аналога 3 из дела (domclick.ru); у аналога 1 из дела — 14 000 000 руб.: проверьте порядок строк и цены в таблице',
    'У аналога № 3 в таблице отчёта цена 14 000 000 руб. — это цена аналога 1 из дела (cian.ru); у аналога 3 из дела — 15 000 000 руб.: проверьте порядок строк и цены в таблице',
  ]);
  // Цена после корректировок аналога 2 — тоже его цена; совпадение цен у двух аналогов — не находка.
  assert.deepEqual(run(report([rows[0], '| 2 | avito.ru | 14 600 000 | 51 | −5 % | 13 775 000 |', rows[2]])), []);
  const same = analogs.map((a, i) => (i === 2 ? { ...a, fields: { ...a.fields, price_rub: 14000000 } } : a));
  assert.deepEqual(texts(runAutoChecks(['analog_match'], [doc([report([rows[0], rows[1], rows[2].replace(/15 000 000/g, '14 000 000')])])], { analogs: same }), 'analog_match'), []);
  // Таблица по столбцам: «Цена предложения» с ценами 1 и 2 наоборот.
  const cols = ['| Показатель | Аналог 1 | Аналог 2 | Аналог 3 |', '| Цена предложения, руб. | 14 500 000 | 14 000 000 | 15 000 000 |', '| Площадь, кв. м | 50,5 | 51 | 52 |', '| Цена после корректировок, руб. | 14 000 000 | 13 775 000 | 15 000 000 |'];
  assert.deepEqual(run(['ОТЧЁТ', 'Сравнительный подход', ...cols, ...links].join('\n')), [
    'У аналога № 1 в таблице отчёта цена 14 500 000 руб. — это цена аналога 2 из дела (avito.ru); у аналога 1 из дела — 14 000 000 руб.: проверьте порядок строк и цены в таблице',
    'У аналога № 2 в таблице отчёта цена 14 000 000 руб. — это цена аналога 1 из дела (cian.ru); у аналога 2 из дела — 14 500 000 руб.: проверьте порядок строк и цены в таблице',
  ], 'каждый столбец строки «Цена предложения» сверяется со своим аналогом; строка «Цена после корректировок» своя');
  // Таблица позиций перечня: номер позиции — не номер аналога (средняя цена позиции 1 = цена аналога 2) — молчим.
  const positions = ['| Позиция | Наименование | Аналоги | Средняя цена после корректировок, руб. |', '| 1 | Холодильник | 2 | 13 775 000 |'];
  assert.deepEqual(run(report(rows, links, positions)), []);
  // Ссылки в приложении под чужими номерами: под «Аналог 1» — объявление аналога 2 из дела и наоборот.
  const mixed = [links[0], links[3], links[2], links[1], links[4], links[5]];
  assert.deepEqual(run(report(rows, mixed)), [
    'У аналога № 1 в отчёте ссылка аналога 2 из дела (avito.ru) — номера в отчёте и в деле разные, а скриншоты в приложении подписаны по делу: проверьте порядок аналогов',
    'У аналога № 2 в отчёте ссылка аналога 1 из дела (cian.ru) — номера в отчёте и в деле разные, а скриншоты в приложении подписаны по делу: проверьте порядок аналогов',
  ]);
  // Ссылка в строке таблицы «| 3 | … ссылка аналога 1 … |» — номер берётся из строки.
  assert.deepEqual(run(report([rows[0], rows[1], '| 3 | https://www.cian.ru/sale/flat/401/ | 15 000 000 | 52 | нет | 15 000 000 |'], links.slice(2))), [
    'У аналога № 3 в отчёте ссылка аналога 1 из дела (cian.ru) — номера в отчёте и в деле разные, а скриншоты в приложении подписаны по делу: проверьте порядок аналогов',
  ]);
  // «Аналоги № 1–3 приведены ниже» и сразу три ссылки подряд — номер у второй и третьей ссылки неизвестен: молчим.
  assert.deepEqual(run(report(rows, ['Аналоги № 1–3: https://www.cian.ru/sale/flat/401/ https://www.avito.ru/moskva/kvartiry/402 https://domclick.ru/card/sale__flat__403'])), []);
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

test('адрес объекта (2.197): сокращения и разные записи одного адреса — не находка; другой адрес — находка', () => {
  const check = (mine, rep) => texts(runAutoChecks(['address_match'], [doc(['Адрес объекта оценки: ' + rep])], { fields: { address: mine } }), 'address_match');
  const same = [
    ['г. Москва, ул. Долевая, д. 3, кв. 8', 'город Москва, улица Долевая, дом 3, квартира 8'],
    ['г. Москва, ул. Долевая, д. 3, кв. 8', 'Москва г., Долевая ул., д.3, кв.8'],
    ['г. Москва, ул. Долевая, д. 3, кв. 8', 'г.Москва,ул.Долевая,д.3,кв.8'],
    // Улица с инициалом «Д.» — не деревня; город без «г.».
    ['г. Москва, ул. Д. Ульянова, д. 3, кв. 8', 'Москва, ул. Д. Ульянова, д. 3, кв. 8'],
    ['г. Москва, ул. Генерала Белова, д. 3, кв. 8', 'г. Москва, ул. Ген. Белова, д. 3, кв. 8'],
    ['г. Москва, ул. Большая Серпуховская, д. 3, кв. 8', 'г. Москва, ул. Б. Серпуховская, д. 3, кв. 8'],
    ['г. Москва, ул. Долевая, д. 5, корп. 2, кв. 8', 'г. Москва, ул. Долевая, д. 5к2, кв. 8'],
    ['г. Москва, Ленинский пр-т, д. 5, кв. 8', 'г. Москва, Ленинский проспект, д. 5, кв. 8'],
    // Новая Москва и внутригородское деление по ФИАС.
    ['г. Москва, пос. Внуковское, д. Ракитки, ул. Лесная, д. 5', 'Москва, поселение Внуковское, д. Ракитки, ул. Лесная, д. 5'],
    ['г. Москва, ул. Долевая, д. 3, кв. 8', 'Москва, вн.тер.г. муниципальный округ Хамовники, ул. Долевая, д. 3, кв. 8'],
    ['Московская обл., г.о. Балашиха, г. Балашиха, ул. Лесная, д. 5, кв. 8', 'Московская область, г. Балашиха, ул. Лесная, д. 5, кв. 8'],
    ['МО, Одинцовский р-н, дер. Тестово, уч. 5', 'Московская область, Одинцовский район, деревня Тестово, участок № 5'],
    ['МО, г. Королёв, ул. Ленина, д. 3, кв. 8', 'Московская обл., г. Королев, ул. Ленина, д. 3, кв. 8'],
  ];
  for (const [mine, rep] of same) assert.deepEqual(check(mine, rep), [], rep);
  // «Акад. Королёва» раньше обрезалось как конец предложения — квартира не сверялась.
  assert.deepEqual(check('г. Москва, ул. Академика Королёва, д. 3, кв. 8', 'г. Москва, ул. Акад. Королёва, д. 3, кв. 18'), [
    'Адрес «г. Москва, ул. Акад. Королёва, д. 3, кв. 18» не совпадает с адресом из заявки (г. Москва, ул. Академика Королёва, д. 3, кв. 8): квартира 18, а в заявке 8 — проверьте, нет ли данных другого объекта',
  ]);
  assert.deepEqual(check('г. Москва, ул. Генерала Белова, д. 3, кв. 8', 'г. Москва, ул. Ген. Петрова, д. 3, кв. 8'), [
    'Адрес «г. Москва, ул. Ген. Петрова, д. 3, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Генерала Белова, д. 3, кв. 8): другая улица — проверьте, нет ли данных другого объекта',
  ]);
  assert.deepEqual(check('г. Москва, ул. Долевая, д. 3, кв. 8', 'Московская обл., г. Химки, ул. Долевая, д. 3, кв. 8'), [
    'Адрес «Московская обл., г. Химки, ул. Долевая, д. 3, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Долевая, д. 3, кв. 8): другой населённый пункт — проверьте, нет ли данных другого объекта',
  ]);
  assert.deepEqual(check('г. Москва, ул. Долевая, д. 5, корп. 2, кв. 8', 'г. Москва, ул. Долевая, д. 5к3, кв. 8'), [
    'Адрес «г. Москва, ул. Долевая, д. 5к3, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Долевая, д. 5, корп. 2, кв. 8): корпус 3, а в заявке 2 — проверьте, нет ли данных другого объекта',
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

test('2.198: дата оценки — как в задании на оценку, письме или определении суда, приложенных к делу', () => {
  const report = doc([
    ['ОТЧЁТ ОБ ОЦЕНКЕ № 124/2026-О', 'Дата оценки: 01.10.2026', 'Дата составления отчёта: 05.10.2026'].join('\n'),
    'Рыночная стоимость квартиры по состоянию на 01.10.2026 составляет 9 000 000 руб.',
  ]);
  const task = (date, name = 'Задание.pdf') => doc([['ЗАДАНИЕ НА ОЦЕНКУ', `Дата оценки: ${date}`].join('\n')], name);
  const ctx = (...assignment) => ({ assignment });
  assert.deepEqual(runAutoChecks(['value_date'], [report], ctx(task('01.10.2026'))).value_date, [], 'дата как в задании');
  assert.deepEqual(runAutoChecks(['value_date'], [report], ctx(task('1 октября 2026 г.'))).value_date, [], 'словами — та же дата');

  const res = runAutoChecks(['value_date'], [report], ctx(task('03.10.2026')));
  assert.deepEqual(texts(res, 'value_date'), [
    'Дата оценки в отчёте 01.10.2026, а в задании на оценку «Задание.pdf» — 03.10.2026 (стр. 1); дата оценки берётся из задания — исправьте отчёт или приложите к делу новое задание',
  ]);
  assert.equal(res.value_date[0].file, 'Отчёт.pdf');
  assert.equal(res.value_date[0].where, 'стр. 1');
  assert.equal(res.value_date[0].quote, 'Дата оценки: 01.10.2026');

  // Определение суда и письмо заказчика — так же, со своим названием.
  const court = doc(['ОПРЕДЕЛЕНИЕ о назначении судебной экспертизы\nМещанский районный суд г. Москвы определил: определить рыночную стоимость квартиры по состоянию на 15.09.2026.'], 'Определение.pdf');
  assert.match(texts(runAutoChecks(['value_date'], [report], ctx(court)), 'value_date')[0], /а в определении суда «Определение\.pdf» — 15\.09\.2026/);
  const letter = doc(['Прошу определить рыночную стоимость квартиры по состоянию на 20.09.2026.'], 'Письмо банка.pdf');
  assert.match(texts(runAutoChecks(['value_date'], [report], ctx(letter)), 'value_date')[0], /а в письме заказчика «Письмо банка\.pdf» — 20\.09\.2026/);

  // В приложенных документах две разные даты (старое и новое задание) — молчим; дат нет — молчим.
  assert.deepEqual(runAutoChecks(['value_date'], [report], ctx(task('03.10.2026'), task('04.10.2026', 'Задание-2.pdf'))).value_date, []);
  assert.deepEqual(runAutoChecks(['value_date'], [report], ctx(doc(['ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки — дата осмотра'], 'Задание.pdf'))).value_date, []);
  // Кадастровая стоимость в выписке — не дата оценки.
  assert.deepEqual(runAutoChecks(['value_date'], [report], ctx(doc(['Кадастровая стоимость по состоянию на 01.01.2026'], 'ЕГРН.pdf'))).value_date, []);
  // В самом отчёте две даты — уже находка «одна во всём отчёте»; с заданием не сверяем, чтобы не дублировать.
  const two = doc(['Дата оценки: 01.10.2026', 'Дата оценки: 01.10.2026', 'по состоянию на 02.10.2026 рыночная стоимость… Рыночная стоимость по состоянию на 02.10.2026']);
  assert.ok(texts(runAutoChecks(['value_date'], [two], ctx(task('03.10.2026'))), 'value_date').every((t) => !/в задании/.test(t)));
});

test('2.202: площадь объекта — как в выписке ЕГРН из дела; без выписки и при разных площадях в выписках — как в заявке', () => {
  const report = doc(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбъект оценки: квартира общей площадью 45,1 кв. м, этаж 3', 'Площадь кухни 8 кв. м. Аналог 1: квартира площадью 52 кв. м']);
  const egrn = (area, name = 'Выписка ЕГРН.pdf', kind = 'Помещение') => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: ${kind}\nПлощадь, м2: ${area}\nКадастровая стоимость, руб.: 7 000 000`], name);
  const run = (fields, ...list) => runAutoChecks(['area_match'], [report], { fields, service: 'realty', egrn: list });
  assert.deepEqual(run({ area: '45.1' }, egrn('45,1')).area_match, [], 'как в выписке и в заявке');
  assert.deepEqual(run({}, egrn('45.1')).area_match, [], 'в заявке площади нет — как в выписке');

  // В заявке площадь не указана — сверка только по выписке.
  let res = run({}, egrn('47,3'));
  assert.deepEqual(texts(res, 'area_match'), ['Площадь 45,1 кв. м не совпадает с площадью в выписке ЕГРН «Выписка ЕГРН.pdf» (47,3 кв. м, стр. 1) — площадь берётся из выписки']);
  assert.equal(res.area_match[0].file, 'Отчёт.pdf');
  assert.match(res.area_match[0].quote, /общей площадью 45,1 кв\. м/);
  // Отчёт по заявке, а выписка — другое: находка одна, с подсказкой про заявку.
  res = run({ area: '45,1' }, egrn('47,3'));
  assert.deepEqual(texts(res, 'area_match'), ['Площадь 45,1 кв. м не совпадает с площадью в выписке ЕГРН «Выписка ЕГРН.pdf» (47,3 кв. м, стр. 1); в заявке — 45,1 кв. м — площадь берётся из выписки']);
  // Отчёт как выписка, в заявке опечатка — находки нет.
  assert.deepEqual(run({ area: '54,1' }, egrn('45,1')).area_match, []);

  // Выписка на участок при оценке квартиры — не в счёт: сверка с заявкой.
  assert.deepEqual(texts(run({ area: '50' }, egrn('1200 +/- 12 кв. м', 'ЕГРН участок.pdf', 'Земельный участок')), 'area_match'),
    ['Площадь 45,1 кв. м не совпадает с площадью из заявки (50 кв. м) — проверьте, нет ли данных другого объекта']);
  // Две выписки с разными площадями — какая верная, решает эксперт: сверка с заявкой; заявки нет — молчим.
  assert.deepEqual(run({}, egrn('47,3'), egrn('48', 'Выписка-2.pdf')).area_match, []);
  assert.deepEqual(run({ area: '45,1' }, egrn('47,3'), egrn('48', 'Выписка-2.pdf')).area_match, []);
  // Выписка без площади — как раньше.
  assert.deepEqual(run({ area: '45,1' }, doc(['Выписка из ЕГРН\nКадастровый номер: 77:01:0001001:1234'])).area_match, []);

  // Участок: площадь из выписки на участок; выписка на дом на участке не мешает.
  const land = doc(['Земельный участок площадью 1 500 кв. м, категория земель: земли населённых пунктов']);
  const lres = runAutoChecks(['area_match'], [land], { fields: { area: 1500 }, service: 'land',
    egrn: [egrn('1200 +/- 12', 'ЕГРН участок.pdf', 'Земельный участок'), egrn('120,5', 'ЕГРН дом.pdf', 'Здание')] });
  assert.deepEqual(texts(lres, 'area_match'), ['Площадь 1 500 кв. м не совпадает с площадью в выписке ЕГРН «ЕГРН участок.pdf» (1 200 кв. м, стр. 1); в заявке — 1 500 кв. м — площадь берётся из выписки']);
});

test('2.203: кадастровый номер — как в выписке ЕГРН из дела; номера участка «в пределах» и квартала не путают', () => {
  const report = doc(['ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира, кадастровый номер 77:01:0001001:1234, общей площадью 45,1 кв. м',
    'Кадастровый квартал 77:01:0001001. Аналог 1: кадастровый номер 77:01:0001001:5555']);
  const egrn = (num, name = 'Выписка ЕГРН.pdf', kind = 'Помещение') => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: ${kind}\nКадастровый номер: ${num}\nНомер кадастрового квартала: 77:01:0001001\nКадастровые номера иных объектов недвижимости, в пределах которых расположен объект недвижимости: 77:01:0001001:10`], name);
  const run = (fields, ...list) => runAutoChecks(['cadastral_match'], [report], { fields, service: 'realty', egrn: list });
  assert.deepEqual(run({}, egrn('77:01:0001001:1234')).cadastral_match, [], 'как в выписке');
  assert.deepEqual(run({ cadastral: '77:01:0001001:1234' }, egrn('77:01:0001001:1234')).cadastral_match, []);

  // В заявке номера нет — сверка только по выписке.
  let res = run({}, egrn('77:01:0001001:4321'));
  assert.deepEqual(texts(res, 'cadastral_match'), ['Кадастровый номер 77:01:0001001:1234 не совпадает с номером в выписке ЕГРН «Выписка ЕГРН.pdf» (77:01:0001001:4321, стр. 1) — проверьте, нет ли данных другого объекта']);
  assert.match(res.cadastral_match[0].quote, /кадастровый номер 77:01:0001001:1234/);
  // Отчёт по заявке, выписка — другое: подсказка про заявку.
  res = run({ cadastral: '77:01:0001001:1234' }, egrn('77:01:0001001:4321'));
  assert.deepEqual(texts(res, 'cadastral_match'), ['Кадастровый номер 77:01:0001001:1234 не совпадает с номером в выписке ЕГРН «Выписка ЕГРН.pdf» (77:01:0001001:4321, стр. 1); в заявке — 77:01:0001001:1234 — проверьте, нет ли данных другого объекта']);
  // Отчёт как выписка, в заявке опечатка — находки нет.
  assert.deepEqual(run({ cadastral: '77:01:0001001:1243' }, egrn('77:01:0001001:1234')).cadastral_match, []);

  // Выписка на участок при оценке квартиры — не в счёт: сверка с заявкой.
  assert.deepEqual(texts(run({ cadastral: '77:01:0001001:7777' }, egrn('77:01:0001001:10', 'ЕГРН участок.pdf', 'Земельный участок')), 'cadastral_match'),
    ['Кадастровый номер 77:01:0001001:1234 не совпадает с номером из заявки (77:01:0001001:7777) — проверьте, нет ли данных другого объекта']);
  // Две выписки с разными номерами — решает эксперт: сверка с заявкой; заявки нет — молчим.
  assert.deepEqual(run({}, egrn('77:01:0001001:4321'), egrn('77:01:0001001:9999', 'Выписка-2.pdf')).cadastral_match, []);
  // Выписка без номера объекта (только «в пределах» и квартал) — как раньше.
  assert.deepEqual(run({}, doc(['Выписка из ЕГРН\nНомер кадастрового квартала: 77:01:0001001\nКадастровые номера иных объектов недвижимости, в пределах которых расположен объект недвижимости: 77:01:0001001:10'])).cadastral_match, []);

  // Участок: номер из выписки на участок; выписка на дом на участке не мешает.
  const land = doc(['Земельный участок, кадастровый номер 50:20:0010101:55, площадью 1 500 кв. м']);
  const lres = runAutoChecks(['cadastral_match'], [land], { fields: {}, service: 'land',
    egrn: [egrn('50:20:0010101:56', 'ЕГРН участок.pdf', 'Земельный участок'), egrn('50:20:0010101:300', 'ЕГРН дом.pdf', 'Здание')] });
  assert.deepEqual(texts(lres, 'cadastral_match'), ['Кадастровый номер 50:20:0010101:55 не совпадает с номером в выписке ЕГРН «ЕГРН участок.pdf» (50:20:0010101:56, стр. 1) — проверьте, нет ли данных другого объекта']);
});

test('2.212: этаж и этажность — как в выписке ЕГРН из дела; помещение на двух этажах, выписка на участок и разные выписки — как в заявке', () => {
  const report = doc(['ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира расположена на 5 этаже 9-этажного жилого дома.', 'Аналог 1: квартира на 7 этаже 12-этажного дома']);
  const flat = (floor, name = 'Выписка ЕГРН.pdf') => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nНомер, тип этажа, на котором расположено помещение, машино-место: ${floor}\nПлощадь, м2: 47,3`], name);
  const house = (floors, name = 'ЕГРН дом.pdf') => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Здание\nКоличество этажей, в том числе подземных этажей: ${floors}`], name);
  const run = (fields, ...list) => runAutoChecks(['floor_match'], [report], { fields, service: 'realty', egrn: list });
  assert.deepEqual(run({}, flat('Этаж № 5'), house('9')).floor_match, [], 'как в выписках');
  assert.deepEqual(run({ floor: '5 / 9' }, flat('Этаж № 5'), house('10, в том числе подземных 1')).floor_match, [], 'надземных 9 — годится');
  assert.deepEqual(run({ floor: '5 / 9' }, flat('Этаж № 1, Этаж № 2')).floor_match, [], 'помещение на двух этажах — как в заявке');

  // В заявке этажа нет — сверка только по выписке; находка ведёт к строке отчёта.
  let res = run({}, flat('Этаж № 6'));
  assert.deepEqual(texts(res, 'floor_match'), ['Этаж 5 не совпадает с этажом в выписке ЕГРН «Выписка ЕГРН.pdf» (6, стр. 1) — проверьте, нет ли данных другого объекта']);
  assert.match(res.floor_match[0].quote, /на 5 этаже/);
  // Отчёт по заявке, а выписки — другое: подсказка про заявку; этажность — с надземными.
  res = run({ floor: '5 / 9' }, flat('Этаж № 6'), house('12, в том числе подземных 1'));
  assert.deepEqual(texts(res, 'floor_match'), [
    'Этаж 5 не совпадает с этажом в выписке ЕГРН «Выписка ЕГРН.pdf» (6, стр. 1); в заявке — 5 — проверьте, нет ли данных другого объекта',
    'Этажей в доме 9, а в выписке ЕГРН «ЕГРН дом.pdf» — 12, из них надземных 11 (стр. 1); в заявке — 9 — проверьте, нет ли данных другого дома',
  ]);
  // Отчёт как выписка, в заявке опечатка — находки нет.
  assert.deepEqual(run({ floor: '6 / 10' }, flat('Номер этажа: 5'), house('9')).floor_match, []);

  // Выписка на участок — не в счёт; две выписки с разными этажами — решает эксперт: сверка с заявкой.
  const plot = doc(['Выписка из ЕГРН\nВид объекта недвижимости: Земельный участок\nНомер этажа: 2'], 'ЕГРН участок.pdf');
  assert.deepEqual(texts(run({ floor: '4' }, plot), 'floor_match'), ['Этаж 5 не совпадает с этажом из заявки (4) — проверьте, нет ли данных другого объекта']);
  assert.deepEqual(run({}, flat('Этаж № 6'), flat('Этаж № 7', 'Выписка-2.pdf')).floor_match, []);
  assert.deepEqual(texts(run({ floor: '4' }, flat('Этаж № 6'), flat('Этаж № 7', 'Выписка-2.pdf')), 'floor_match'),
    ['Этаж 5 не совпадает с этажом из заявки (4) — проверьте, нет ли данных другого объекта']);
  // Выписка без этажа — как раньше; без заявки и выписки — молчим.
  assert.deepEqual(run({}, doc(['Выписка из ЕГРН\nКадастровый номер: 77:01:0001001:1234'])).floor_match, []);
  assert.deepEqual(run({}).floor_match, []);
});
test('2.223: год постройки и материал стен — как в выписке ЕГРН на здание из дела; без неё год — как в заявке', () => {
  const report = doc([
    'ОТЧЁТ ОБ ОЦЕНКЕ\nКвартира в кирпичном 9-этажном жилом доме 1975 года постройки.\nСтены: обои, панели ПВХ.',
    'Описание дома\nГод постройки: 1975, капитальный ремонт 2010\nМатериал наружных стен: кирпич',
    'Аналог 1: панельный дом 1990 года постройки\nГод постройки 1975 1990 1984',
  ]);
  const house = (lines, name = 'ЕГРН дом.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Здание\n${lines}`], name), id: name });
  const run = (fields, ...list) => runAutoChecks(['building_match'], [report], { fields, service: 'realty', egrn: list });
  // Как в выписке; «Год завершения строительства» на год раньше ввода — годится любой; капремонт и аналоги не в счёт.
  assert.deepEqual(run({}, house('Год ввода в эксплуатацию по завершении строительства: 1975\nМатериал наружных стен: Кирпичные')).building_match, []);
  assert.deepEqual(run({ year_built: 1976 }, house('Год завершения строительства: 1974\nГод ввода в эксплуатацию: 1975\nМатериал наружных стен: Каменные и кирпичные')).building_match, []);
  assert.deepEqual(run({}, house('Материал наружных стен: Смешанные')).building_match, [], '«Смешанные» не сверяем');

  // Выписка — другой дом: год и стены; в заявке — свой год; находка ведёт к выписке.
  let res = run({ year_built: 1975 }, house('Год ввода в эксплуатацию по завершении строительства: 1984\nМатериал наружных стен: Панельные'));
  assert.deepEqual(texts(res, 'building_match'), [
    'Год постройки 1975 не совпадает с выпиской ЕГРН «ЕГРН дом.pdf» (1984, стр. 1); в заявке — 1975 — проверьте, нет ли данных другого дома',
    'Материал стен «кирпичном 9-этажном жилом доме» не совпадает с выпиской ЕГРН «ЕГРН дом.pdf» («Панельные», стр. 1) — проверьте, нет ли данных другого дома',
  ]);
  assert.match(res.building_match[0].quote, /1975 года постройки/);
  assert.equal(res.building_match[0].egrn.where, 'стр. 1');
  assert.match(res.building_match[1].egrn.quote, /Материал наружных стен: Панельные/);
  // «Монолитно-кирпичный» сходится и с монолитом.
  const mono = doc(['Жилой дом монолитно-кирпичный.\nМатериал стен: монолитно-кирпичные']);
  assert.deepEqual(runAutoChecks(['building_match'], [mono], { fields: {}, service: 'realty', egrn: [house('Материал наружных стен: Монолитные')] }).building_match, []);

  // Без выписки — год по заявке, материал не сверяем; выписки спорят — как без выписки.
  assert.deepEqual(texts(run({ year_built: 1976 }), 'building_match'), ['Год постройки 1975 не совпадает с годом из заявки (1976) — проверьте, нет ли данных другого дома']);
  assert.deepEqual(texts(run({ year_built: 1976 }, house('Год ввода в эксплуатацию: 1980\nМатериал наружных стен: Панельные'), house('Год ввода в эксплуатацию: 1990\nМатериал наружных стен: Деревянные', 'ЕГРН-2.pdf')), 'building_match'),
    ['Год постройки 1975 не совпадает с годом из заявки (1976) — проверьте, нет ли данных другого дома']);
  // Выписка на участок и оценка участка — не в счёт; без заявки и выписки — молчим.
  const plot = doc(['Выписка из ЕГРН\nВид объекта недвижимости: Земельный участок\nГод ввода в эксплуатацию: 1990'], 'ЕГРН участок.pdf');
  assert.deepEqual(run({}, plot).building_match, []);
  assert.deepEqual(runAutoChecks(['building_match'], [report], { fields: { year_built: 1980 }, service: 'land', egrn: [] }).building_match, []);
  assert.deepEqual(run({}).building_match, []);
});
test('2.213: адрес объекта — как в выписке ЕГРН из дела; выписка на участок, выписки на дом и квартиру и разные выписки', () => {
  const report = doc(['ОТЧЁТ ОБ ОЦЕНКЕ\nАдрес объекта оценки: г. Москва, ул. Долевая, д. 3, кв. 8\nАналог 1: г. Москва, ул. Лесная, д. 5, кв. 1']);
  const flat = (addr, name = 'Выписка ЕГРН.pdf') => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nАдрес (местоположение): ${addr}\nПлощадь, м2: 47,3`], name);
  const house = (addr, name = 'ЕГРН дом.pdf') => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Здание\nМестоположение: ${addr}`], name);
  const run = (fields, ...list) => texts(runAutoChecks(['address_match'], [report], { fields, service: 'realty', egrn: list }), 'address_match');
  // Как в выписке — записанной по ФИАС, без точек — не находка; в заявке адреса нет — сверка только с выпиской.
  assert.deepEqual(run({}, flat('Российская Федерация, город Москва, вн.тер.г. муниципальный округ Хамовники, улица Долевая, дом 3, квартира 8')), []);
  assert.deepEqual(run({ address: 'г. Москва, ул. Долевая, д. 3, кв. 8' }, flat('г.Москва, ул Долевая, д 3, кв 8'), house('г. Москва, ул. Долевая, д. 3')), [], 'дом и квартира в нём не спорят');
  assert.deepEqual(run({}, flat('г. Москва, ул. Долевая, д. 3, кв. 18')), [
    'Адрес «г. Москва, ул. Долевая, д. 3, кв. 8» не совпадает с адресом в выписке ЕГРН «Выписка ЕГРН.pdf» (г. Москва, ул. Долевая, д. 3, кв. 18, стр. 1): квартира 8, а в выписке 18 — проверьте, нет ли данных другого объекта',
  ]);
  // Отчёт по заявке, а в выписке другое — подсказка про заявку; другая улица — без номеров.
  assert.deepEqual(run({ address: 'г. Москва, ул. Долевая, д. 3, кв. 8' }, flat('г. Москва, ул. Лесная, д. 3, кв. 8')), [
    'Адрес «г. Москва, ул. Долевая, д. 3, кв. 8» не совпадает с адресом в выписке ЕГРН «Выписка ЕГРН.pdf» (г. Москва, ул. Лесная, д. 3, кв. 8, стр. 1); в заявке — г. Москва, ул. Долевая, д. 3, кв. 8: другая улица — проверьте, нет ли данных другого объекта',
  ]);
  // Отчёт как выписка, в заявке опечатка — находки нет.
  assert.deepEqual(run({ address: 'г. Москва, ул. Долевая, д. 3, кв. 80' }, flat('г. Москва, ул. Долевая, д. 3, кв. 8')), []);
  // Выписка на участок при оценке квартиры — не в счёт; две выписки с разными адресами — решает эксперт: сверка с заявкой.
  const plot = doc(['Выписка из ЕГРН\nВид объекта недвижимости: Земельный участок\nМестоположение: Московская обл., г. Химки, ул. Лесная, уч. 5'], 'ЕГРН участок.pdf');
  assert.deepEqual(run({}, plot), []);
  assert.deepEqual(run({ address: 'г. Москва, ул. Долевая, д. 3, кв. 9' }, plot), [
    'Адрес «г. Москва, ул. Долевая, д. 3, кв. 8» не совпадает с адресом из заявки (г. Москва, ул. Долевая, д. 3, кв. 9): квартира 8, а в заявке 9 — проверьте, нет ли данных другого объекта',
  ]);
  assert.deepEqual(run({}, flat('г. Москва, ул. Долевая, д. 3, кв. 18'), flat('г. Москва, ул. Долевая, д. 3, кв. 28', 'Выписка-2.pdf')), []);
  // Выписка без адреса — как раньше; без заявки и выписки — молчим.
  assert.deepEqual(run({}, doc(['Выписка из ЕГРН\nКадастровый номер: 77:01:0001001:1234'])), []);
  assert.deepEqual(run({}), []);
});

// 2.231: находка, сверенная с заявкой или заданием на оценку (не с выпиской), тоже несёт «что разошлось и что верно» —
// для «Исправить в черновике»; у находки по выписке ЕГРН это по-прежнему в `egrn` (2.229).
test('2.231: находки по заявке и заданию на оценку — что разошлось и откуда верное значение', () => {
  const fields = { area: '54,3', cadastral: '77:01:0001001:4321', floor: '6 из 9', year_built: '1984', address: 'г. Москва, ул. Долевая, д. 3, кв. 18' };
  const report = doc([[
    'ОТЧЁТ ОБ ОЦЕНКЕ',
    'Адрес объекта: г. Москва, ул. Долевая, д. 3, кв. 8',
    'Кадастровый номер объекта: 77:01:0001001:1234',
    'Квартира общей площадью 45,1 кв. м расположена на 5 этаже 9-этажного дома.',
    'Год постройки 1975.',
  ].join('\n')]);
  const res = runAutoChecks(['area_match', 'cadastral_match', 'floor_match', 'building_match', 'address_match'], [report], { fields, service: 'realty' });
  const fix = (rule) => res[rule].map((f) => f.fix);
  assert.deepEqual(fix('area_match'), [{ bad: '45,1', right: '54,3', from: 'в заявке' }]);
  assert.deepEqual(fix('cadastral_match'), [{ bad: '77:01:0001001:1234', right: '77:01:0001001:4321', from: 'в заявке' }]);
  assert.deepEqual(fix('floor_match'), [{ bad: '5', right: '6', from: 'в заявке' }]);
  assert.deepEqual(fix('building_match'), [{ bad: '1975', right: '1984', from: 'в заявке' }]);
  assert.deepEqual(fix('address_match'), [{ bad: 'г. Москва, ул. Долевая, д. 3, кв. 8', right: 'г. Москва, ул. Долевая, д. 3, кв. 18', from: 'в заявке' }]);
  for (const rule of Object.keys(res)) assert.ok(res[rule].every((f) => !f.egrn), rule);

  // Дата оценки — как в задании: верная дата и откуда она.
  const dated = doc([['ОТЧЁТ ОБ ОЦЕНКЕ', 'Дата оценки: 01.10.2026'].join('\n')]);
  const task = doc([['ЗАДАНИЕ НА ОЦЕНКУ', 'Дата оценки: 03.10.2026'].join('\n')], 'Задание.pdf');
  assert.deepEqual(runAutoChecks(['value_date'], [dated], { assignment: [task] }).value_date.map((f) => f.fix),
    [{ bad: '01.10.2026', right: '03.10.2026', from: 'в задании на оценку «Задание.pdf»' }]);

  // С выпиской ЕГРН — по-прежнему в `egrn`, без отдельного `fix`.
  const egrn = [{ id: 'e1', name: 'Выписка ЕГРН.pdf', kind: 'pdf', pages: ['Выписка из Единого государственного реестра недвижимости\nПлощадь, м2: 47,3'] }];
  const withEgrn = runAutoChecks(['area_match'], [report], { fields, service: 'realty', egrn });
  assert.deepEqual(withEgrn.area_match.map((f) => [f.fix, f.egrn?.bad, f.egrn?.right]), [[undefined, '45,1', '47,3']]);
});

test('2.231: место в черновике для даты оценки — цифрами и словами', async () => {
  const { findInDraft } = await import('../../public/draftfind.js');
  const at = (body) => { const r = findInDraft(body, { bad: '01.10.2026', quote: 'Дата оценки: 01.10.2026' }); return r && body.slice(r.from, r.to); };
  assert.equal(at('| Дата оценки | 01.10.2026 |'), '01.10.2026');
  assert.equal(at('Дата оценки — «01» октября 2026 г.'), '«01» октября 2026');
  assert.equal(at('по состоянию на 1 октября 2026 г.'), '1 октября 2026');
  assert.equal(at('Дата составления 11.10.2026, договор 101.10.2026'), null);
  assert.equal(at('11 октября 2026'), null);
});
test('2.241: правообладатель и вид права в отчёте — как в выписке ЕГРН на объект', () => {
  const report = doc([
    'ОТЧЁТ ОБ ОЦЕНКЕ\nСобственник объекта оценки: Петров Пётр Петрович\nВид права: общая долевая собственность, доля 1/2',
    'Сведения о правах\nПравообладатель: Иванова Мария Ивановна\nОбъект принадлежит на праве общей долевой собственности\nОцениваемые права: право собственности\nПрежний собственник: Сидоров Семён Семёнович\nАналог 1: собственник — Кузнецов К.К.',
  ]);
  const egrn = (lines, name = 'Выписка ЕГРН.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nРаздел 2. Сведения о зарегистрированных правах\n${lines}`], name), id: name });
  const run = (e, fields = { object_type: 'flat' }) => runAutoChecks(['rights_match'], [report], { fields, service: 'realty', egrn: e });
  // Как в выписке: «Иванова» к «Иванов Иван Иванович» — тот же человек? Нет: первая буква имени другая — находка.
  let res = run([egrn('1. Правообладатель (правообладатели): 1.1. Петров Пётр Петрович\n1.2. Иванова Мария Ивановна\n2. Вид, номер и дата государственной регистрации права: 2.1. Общая долевая собственность, № 77:01:0001001:4321-77/051/2020-3, 15.03.2020, доля в праве 1/2')]);
  assert.deepEqual(res.rights_match, []);
  // Другой собственник и единоличная собственность в выписке: находки с кнопкой к строке выписки и «Исправить в черновике».
  res = run([egrn('1. Правообладатель (правообладатели): 1.1. Сергеев Сергей Сергеевич\n2. Вид, номер, дата и время государственной регистрации права: 2.1. Собственность\n77:01:0001001:4321-77/051/2020-3\n15.03.2020 12:00:00')]);
  assert.deepEqual(texts(res, 'rights_match'), [
    'Правообладатель «Петров Пётр Петрович» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (Сергеев Сергей Сергеевич, стр. 1) — проверьте, нет ли данных другого объекта или старого отчёта',
    'Вид права «общая долевая собственность» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («Собственность», стр. 1) — проверьте раздел о правах на объект оценки',
    'Правообладатель «Иванова Мария Ивановна» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (Сергеев Сергей Сергеевич, стр. 1) — проверьте, нет ли данных другого объекта или старого отчёта',
  ]);
  assert.equal(res.rights_match[0].egrn.bad, 'Петров Пётр Петрович');
  assert.equal(res.rights_match[0].egrn.right, 'Сергеев Сергей Сергеевич');
  assert.match(res.rights_match[0].egrn.quote, /Правообладатель/);
  assert.equal(res.rights_match[1].egrn.bad, 'общая долевая собственность');
  assert.equal(res.rights_match[1].egrn.right, 'Собственность');
  // Женская фамилия и инициалы — тот же человек; другая первая буква имени — другой.
  const one = (text, holder) => runAutoChecks(['rights_match'], [doc([text])], { fields: { object_type: 'flat' }, service: 'realty',
    egrn: [egrn(`1. Правообладатель (правообладатели): 1.1. ${holder}\n2. Вид, номер и дата государственной регистрации права: 2.1. Общая совместная собственность`)] }).rights_match.length;
  assert.equal(one('Правообладатель: Иванов И.И.', 'Иванов Иван Иванович'), 0);
  assert.equal(one('Собственник: Петровская Анна Сергеевна', 'Петровская Анна Сергеевна'), 0);
  assert.equal(one('Собственник: Иванов П.И.', 'Иванов Иван Иванович'), 1);
  assert.equal(one('Правообладатель: ООО «Ромашка»', 'Общество с ограниченной ответственностью ООО «Ромашка»'), 0);
  assert.equal(one('Вид права: общая совместная собственность', 'Иванов Иван Иванович'), 0);
  assert.equal(one('Вид права: собственность', 'Иванов Иван Иванович'), 1);
  assert.equal(one('Имущественные права на объект оценки: право собственности', 'Иванов Иван Иванович'), 0);
  // Сведения о правообладателе скрыты — имя не сверяем; вид права — да.
  res = run([egrn('1. Правообладатель (правообладатели): 1.1. Сведения о правообладателе не предоставлены\n2. Вид, номер и дата государственной регистрации права: 2.1. Собственность')]);
  assert.deepEqual(res.rights_match.map((f) => f.egrn.bad), ['общая долевая собственность']);
  // Выписка на дом при оценке квартиры не в счёт; разные виды права в выписках — вид не сверяем; без выписки — молчим.
  const house = { ...doc(['Выписка из ЕГРН\nВид объекта недвижимости: Здание\nПравообладатель: 1.1. Сергеев Сергей Сергеевич\nВид, номер и дата государственной регистрации права: Собственность']), id: 'h' };
  assert.deepEqual(run([egrn('Площадь, м2: 47,3'), house]).rights_match, []);
  assert.deepEqual(run([egrn('Вид, номер и дата государственной регистрации права: Собственность'), egrn('Вид, номер и дата государственной регистрации права: Общая совместная собственность', 'Выписка-2.pdf')]).rights_match, []);
  assert.deepEqual(run([]).rights_match, []);
  assert.ok(AUTO_CHECKS.rights_match);
});
test('2.253: размер доли в отчёте — как в выписке ЕГРН на объект', () => {
  const egrn = (lines, name = 'Выписка ЕГРН.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nРаздел 2. Сведения о зарегистрированных правах\n${lines}`], name), id: name });
  const run = (pages, e, fields = { object_type: 'share' }) => runAutoChecks(['share_egrn_match'], [doc(pages)], { fields, service: 'realty', egrn: e });
  const half = egrn('1. Правообладатель (правообладатели): 1.1. Петров Пётр Петрович\n2. Вид, номер и дата государственной регистрации права: 2.1. Общая долевая собственность, № 77:01:0001001:4321-77/051/2020-3, 15.03.2020, доля в праве 1/2');
  // Как в выписке (и 2/4 — то же); номер регистрации «77/051» долей не считается; аналоги и этажи — не про объект.
  assert.deepEqual(run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбъект оценки: 1/2 доли в праве общей долевой собственности на квартиру\nДоля: 2/4', 'Аналог 1: доля 1/3 в квартире\nЭтаж 5/9'], [half]).share_egrn_match, []);
  // Другая доля — находка с кнопкой к строке выписки и «Исправить в черновике».
  let res = run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбъект оценки: 1/3 доли в праве на квартиру', 'Расчёт: стоимость доли 1/3 = 3 000 000 руб.\nПрежний собственник продал долю 1/4'], [half]);
  assert.deepEqual(texts(res, 'share_egrn_match'), ['Доля 1/3 не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (доля в праве 1/2, стр. 1) — проверьте, не доля ли это другого собственника или другого объекта']);
  assert.equal(res.share_egrn_match[0].quote, 'Объект оценки: 1/3 доли в праве на квартиру');
  assert.equal(res.share_egrn_match[0].egrn.bad, '1/3');
  assert.equal(res.share_egrn_match[0].egrn.right, '1/2');
  assert.match(res.share_egrn_match[0].egrn.quote, /доля в праве 1\/2/);
  // У собственников разные доли — любая из них не находка; чужая — находка без замены.
  const many = egrn('Правообладатель (правообладатели): 1.1. Петров Пётр Петрович (доля 1/2)\n1.2. Петрова Анна Ивановна\nВид, номер и дата государственной регистрации права: Общая долевая собственность, 1/4\nДоля в праве: 1/4');
  assert.deepEqual(run(['Доля 1/4 в квартире'], [many]).share_egrn_match, []);
  res = run(['Оценивается доля 2/3'], [many]);
  assert.deepEqual(texts(res, 'share_egrn_match'), ['Доля 2/3 не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (доли в праве: 1/2, 1/4, стр. 1) — проверьте, не доля ли это другого собственника или другого объекта']);
  assert.equal(res.share_egrn_match[0].egrn.bad, undefined);
  // Долей в выписке нет (единоличная собственность — это `rights_match`), без выписки, выписка на дом при оценке квартиры — молчим.
  assert.deepEqual(run(['Доля 1/3'], [egrn('Вид, номер и дата государственной регистрации права: Собственность')]).share_egrn_match, []);
  assert.deepEqual(run(['Доля 1/3'], []).share_egrn_match, []);
  const house = { ...doc(['Выписка из ЕГРН\nВид объекта недвижимости: Здание\nВид, номер и дата государственной регистрации права: Общая долевая собственность, 1/5']), id: 'h' };
  assert.deepEqual(run(['Доля 1/3'], [egrn('Площадь, м2: 47,3'), house], { object_type: 'flat' }).share_egrn_match, []);
  assert.ok(AUTO_CHECKS.share_egrn_match);
});
test('2.259: назначение помещения (жилое / нежилое) в отчёте — как в выписке ЕГРН на объект', () => {
  const egrn = (lines, name = 'Выписка ЕГРН.pdf', kind = 'Помещение') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: ${kind}\nКадастровый номер: 77:01:0001001:4321\n${lines}`], name), id: name });
  const run = (pages, e, fields = { object_type: 'flat' }) => runAutoChecks(['use_match'], [doc(pages)], { fields, service: 'realty', egrn: e });
  const living = egrn('Назначение помещения: Жилое помещение\nНазначение здания: Многоквартирный дом');
  // Как в выписке; назначение здания, аналоги, нежилые помещения на первом этаже дома — не про объект.
  assert.deepEqual(run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбъект оценки: квартира, жилое помещение\nНазначение: жилое', 'Описание дома: назначение здания — многоквартирный дом\nАналог 2: назначение — нежилое помещение\nНа первом этаже дома — нежилые помещения'], [living]).use_match, []);
  // В отчёте «нежилое» — находка с кнопкой к выписке и «Исправить в черновике» в той же форме.
  let res = run(['ОТЧЁТ ОБ ОЦЕНКЕ', 'Характеристики объекта\nНазначение помещения: Нежилое\nОбъект оценки: нежилое помещение площадью 47,3 кв. м'], [living]);
  assert.deepEqual(texts(res, 'use_match'), ['Назначение помещения «нежилое» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («Жилое помещение», стр. 1) — проверьте, нет ли данных другого объекта']);
  assert.equal(res.use_match[0].where, 'стр. 2');
  assert.equal(res.use_match[0].quote, 'Назначение помещения: Нежилое');
  assert.equal(res.use_match[0].egrn.bad, 'Нежилое');
  assert.equal(res.use_match[0].egrn.right, 'Жилое');
  assert.equal(res.use_match[0].egrn.flip, 'не');
  assert.match(res.use_match[0].egrn.quote, /Назначение помещения: Жилое помещение/);
  // Нежилое помещение в жилом доме: заявка «квартира», выписка — нежилое; в отчёте «жилое помещение» — находка с подсказкой о заявке.
  const office = egrn('Назначение: нежилое\nНазначение здания: Жилой дом');
  assert.deepEqual(run(['Объект оценки: нежилое помещение в жилом доме', 'Назначение здания: жилое'], [office], { object_type: 'commercial' }).use_match, []);
  res = run(['Объект оценки: жилое помещение (квартира)'], [office]);
  assert.deepEqual(texts(res, 'use_match'), ['Назначение помещения «жилое» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («нежилое», стр. 1); в заявке — жилое — проверьте, нет ли данных другого объекта']);
  assert.equal(res.use_match[0].egrn.bad, 'жилое');
  assert.equal(res.use_match[0].egrn.right, 'нежилое');
  // Дом: назначение здания — его; садовый дом «нежилое здание», а в отчёте «жилой дом».
  const garden = egrn('Назначение: Нежилое здание', 'ЕГРН дом.pdf', 'Здание');
  res = run(['Объект оценки: жилой дом с участком'], [garden], { object_type: 'house' });
  assert.deepEqual(texts(res, 'use_match'), ['Назначение дома «жилое» не совпадает с выпиской ЕГРН «ЕГРН дом.pdf» («Нежилое здание», стр. 1); в заявке — жилое — проверьте, нет ли данных другого объекта']);
  assert.equal(res.use_match[0].egrn.right, 'нежилой');
  // Без выписки — как в заявке, «Исправить в черновике» по заявке.
  res = run(['Назначение помещения: нежилое'], []);
  assert.deepEqual(texts(res, 'use_match'), ['Назначение помещения «нежилое» не совпадает с заявкой (жилое) — проверьте, нет ли данных другого объекта']);
  assert.equal(res.use_match[0].fix.from, 'в заявке');
  assert.equal(res.use_match[0].fix.right, 'жилое');
  // Выписки спорят — сверяем с заявкой; выписка на участок, земля, нет заявки и выписки — молчим.
  assert.deepEqual(texts(run(['Назначение: нежилое'], [living, egrn('Назначение помещения: Нежилое помещение', 'ЕГРН-2.pdf')], { object_type: 'commercial' }), 'use_match'), []);
  const plot = egrn('Назначение: нежилое', 'ЕГРН участок.pdf', 'Земельный участок');
  assert.deepEqual(texts(run(['Назначение: нежилое'], [plot], { object_type: 'commercial' }), 'use_match'), []);
  assert.deepEqual(runAutoChecks(['use_match'], [doc(['Назначение: нежилое'])], { fields: {}, service: 'realty', egrn: [] }).use_match, []);
  assert.deepEqual(runAutoChecks(['use_match'], [doc(['Назначение: нежилое'])], { fields: { object_type: 'flat' }, service: 'land', egrn: [living] }).use_match, []);
  assert.ok(AUTO_CHECKS.use_match);
  // Строка «Назначение помещения» сразу после вида права — не часть вида права (иначе вид права не узнавался).
  const next = egrn('Вид, номер и дата государственной регистрации права: 2.1. Собственность\nНазначение помещения: Жилое помещение');
  assert.deepEqual(texts(runAutoChecks(['rights_match'], [doc(['Вид права: общая долевая собственность'])], { fields: { object_type: 'flat' }, service: 'realty', egrn: [next] }), 'rights_match'),
    ['Вид права «общая долевая собственность» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («Собственность», стр. 1) — проверьте раздел о правах на объект оценки']);
});
test('2.267: вид жилого помещения (квартира / комната) в отчёте — как в выписке ЕГРН на объект', () => {
  const egrn = (lines, name = 'Выписка ЕГРН.pdf', kind = 'Помещение') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: ${kind}\nКадастровый номер: 77:01:0001001:4321\n${lines}`], name), id: name });
  const run = (pages, e, fields = { object_type: 'room' }) => runAutoChecks(['room_kind_match'], [doc(pages)], { fields, service: 'realty', egrn: e });
  const room = egrn('Назначение помещения: Жилое помещение\nВид жилого помещения: Комната');
  // Как в выписке; «трёхкомнатной квартире», комнаты в составе квартиры, аналоги — не про вид объекта.
  assert.deepEqual(run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбъект оценки: комната в трёхкомнатной квартире', 'Состав объекта оценки: комнаты — 3, кухня\nАналог 1. Объект оценки: квартира'], [room]).room_kind_match, []);
  // В отчёте «квартира» — находка с кнопкой к выписке и «Исправить в черновике» в той же форме слова.
  let res = run(['ОТЧЁТ ОБ ОЦЕНКЕ', 'Вид жилого помещения: Квартира\nОбъект оценки — квартира площадью 18,2 кв. м'], [room]);
  assert.deepEqual(texts(res, 'room_kind_match'), ['Вид жилого помещения «квартира» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («Комната», стр. 1) — проверьте, нет ли данных другого объекта']);
  assert.equal(res.room_kind_match[0].where, 'стр. 2');
  assert.equal(res.room_kind_match[0].quote, 'Вид жилого помещения: Квартира');
  assert.equal(res.room_kind_match[0].egrn.bad, 'Квартира');
  assert.equal(res.room_kind_match[0].egrn.flip, 'kind');
  assert.match(res.room_kind_match[0].egrn.quote, /Вид жилого помещения: Комната/);
  assert.equal(swapValue(res.room_kind_match[0].egrn, 'Квартира'), 'Комната');
  assert.equal(swapValue(res.room_kind_match[0].egrn, 'квартиру'), 'комнату');
  // Заявка «квартира», выписка — «Наименование: Комната»: в отчёте «двухкомнатная квартира» — находка с подсказкой о заявке.
  const named = egrn('Наименование: Комната');
  res = run(['Объект оценки: двухкомнатная квартира'], [named], { object_type: 'flat' });
  assert.deepEqual(texts(res, 'room_kind_match'), ['Вид жилого помещения «квартира» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («Комната», стр. 1); в заявке — квартира — проверьте, нет ли данных другого объекта']);
  // Доля: сверяем только с выпиской («1/2 доли в праве на комнату» при выписке на квартиру).
  res = run(['Объект оценки: 1/2 доли в праве на комнату'], [egrn('Вид жилого помещения: квартира')], { object_type: 'share' });
  assert.deepEqual(texts(res, 'room_kind_match'), ['Вид жилого помещения «комната» не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» («квартира», стр. 1) — проверьте, нет ли данных другого объекта']);
  assert.equal(swapValue(res.room_kind_match[0].egrn, 'комнату'), 'квартиру');
  assert.deepEqual(run(['Объект оценки: 1/2 доли в праве на комнату'], [], { object_type: 'share' }).room_kind_match, []);
  // Без выписки — как в заявке, «Исправить в черновике» по заявке.
  res = run(['Объект оценки: квартира'], []);
  assert.deepEqual(texts(res, 'room_kind_match'), ['Вид жилого помещения «квартира» не совпадает с заявкой (комната) — проверьте, нет ли данных другого объекта']);
  assert.equal(res.room_kind_match[0].fix.from, 'в заявке');
  assert.equal(res.room_kind_match[0].fix.right, 'комната');
  // Выписки спорят — сверяем с заявкой; дом, нежилое, земля, выписка на здание — молчим.
  assert.deepEqual(run(['Объект оценки: комната'], [room, egrn('Вид жилого помещения: Квартира', 'ЕГРН-2.pdf')]).room_kind_match, []);
  assert.deepEqual(run(['Объект оценки: квартира'], [room], { object_type: 'house' }).room_kind_match, []);
  assert.deepEqual(run(['Объект оценки: квартира'], [room], { object_type: 'commercial' }).room_kind_match, []);
  assert.deepEqual(runAutoChecks(['room_kind_match'], [doc(['Объект оценки: квартира'])], { fields: { object_type: 'room' }, service: 'land', egrn: [room] }).room_kind_match, []);
  const building = egrn('Наименование: Квартира', 'ЕГРН дом.pdf', 'Здание');
  assert.deepEqual(texts(run(['Объект оценки: квартира'], [building], { object_type: 'flat' }), 'room_kind_match'), []);
  assert.ok(AUTO_CHECKS.room_kind_match);
});
test('2.242: обременения из выписки ЕГРН упомянуты в отчёте', () => {
  const egrn = (lines, name = 'Выписка ЕГРН.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\nРаздел 2. Сведения о зарегистрированных правах\nПравообладатель (правообладатели): 1.1. Петров Пётр Петрович\n${lines}`], name), id: name });
  const run = (pages, e) => runAutoChecks(['encumbrance_match'], [doc(pages)], { fields: { object_type: 'flat' }, service: 'realty', egrn: e });
  const mortgage = egrn('4. Ограничение прав и обременение объекта недвижимости:\n4.1.1. вид: Ипотека в силу закона\nдата государственной регистрации: 15.03.2020\nлицо, в пользу которого установлено ограничение прав и обременение объекта недвижимости: ПАО Сбербанк\nЗаявленные в судебном порядке права требования: данные отсутствуют');
  // Ипотека в выписке, в отчёте — ни слова (ипотечные ставки на рынке и цель «для ипотеки» не в счёт): находка без исправления.
  let res = run(['ОТЧЁТ ОБ ОЦЕНКЕ\nЦель оценки: для ипотеки\nСведения о правах\nСобственник: Петров Пётр Петрович', 'Анализ рынка: ипотечные ставки снизились\nАналог 1: квартира в залоге'], [mortgage]);
  assert.deepEqual(texts(res, 'encumbrance_match'), ['В выписке ЕГРН «Выписка ЕГРН.pdf» есть обременение — ипотека («Ипотека в силу закона», стр. 1), а в отчёте оно не упомянуто: укажите его в разделе о правах и обременениях']);
  assert.match(res.encumbrance_match[0].egrn.quote, /вид: Ипотека в силу закона/);
  assert.equal(res.encumbrance_match[0].egrn.bad, undefined);
  // Отчёт прямо говорит «обременения не зарегистрированы» — находка у этой строки с «Исправить в черновике».
  res = run(['ОТЧЁТ ОБ ОЦЕНКЕ', 'Права на объект\nОбременения: не зарегистрированы'], [mortgage]);
  assert.deepEqual(texts(res, 'encumbrance_match'), ['В отчёте сказано, что обременений нет, а в выписке ЕГРН «Выписка ЕГРН.pdf» — ипотека («Ипотека в силу закона», стр. 1): укажите обременение в разделе о правах и обременениях']);
  assert.equal(res.encumbrance_match[0].where, 'стр. 2');
  assert.equal(res.encumbrance_match[0].quote, 'Обременения: не зарегистрированы');
  assert.equal(res.encumbrance_match[0].egrn.bad, 'не зарегистрированы');
  assert.equal(res.encumbrance_match[0].egrn.right, 'Ипотека в силу закона');
  // Упомянута — молчим; залог тоже считается; арест и аренда — каждая своей находкой.
  assert.deepEqual(run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбременения: ипотека в пользу ПАО Сбербанк'], [mortgage]).encumbrance_match, []);
  assert.deepEqual(run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбъект находится в залоге у банка'], [mortgage]).encumbrance_match, []);
  const two = egrn('Ограничение прав и обременение объекта недвижимости: вид: Арест\nвид: Аренда (в том числе субаренда)\nсрок действия: с 01.01.2024 по 01.01.2029');
  res = run(['ОТЧЁТ ОБ ОЦЕНКЕ\nОбременения: арест по постановлению пристава'], [two]);
  assert.deepEqual(texts(res, 'encumbrance_match'), ['В выписке ЕГРН «Выписка ЕГРН.pdf» есть обременение — аренда («Аренда (в том числе субаренда)», стр. 1), а в отчёте оно не упомянуто: укажите его в разделе о правах и обременениях']);
  assert.equal(res.encumbrance_match[0].quote, 'Обременения: арест по постановлению пристава');
  // В выписке «не зарегистрировано», без выписки, выписка на дом при оценке квартиры — молчим.
  assert.deepEqual(run(['ОТЧЁТ'], [egrn('Ограничение прав и обременение объекта недвижимости: не зарегистрировано')]).encumbrance_match, []);
  assert.deepEqual(run(['ОТЧЁТ'], []).encumbrance_match, []);
  const house = { ...doc(['Выписка из ЕГРН\nВид объекта недвижимости: Здание\nОграничение прав и обременение объекта недвижимости: вид: Арест']), id: 'h' };
  assert.deepEqual(run(['ОТЧЁТ'], [egrn('Площадь, м2: 47,3'), house]).encumbrance_match, []);
  assert.ok(AUTO_CHECKS.encumbrance_match);
});
test('2.233: кадастровая стоимость в отчёте — как в выписке ЕГРН из дела', () => {
  const report = doc([
    'ОТЧЁТ ОБ ОЦЕНКЕ\nКадастровая стоимость объекта оценки: 8 200 000 руб.\nУдельный показатель кадастровой стоимости: 170 000 руб./кв. м',
    'Описание\nКадастровая стоимость квартиры составляет 8,2 млн руб.\nКадастровая стоимость земельного участка под домом: 95 000 000 руб.\nАналог 1: кадастровая стоимость 7 000 000 руб.',
    'Справочно: кадастровая стоимость по состоянию на 01.01.2021 — 6 500 000 руб.\nРыночная стоимость объекта: 9 100 000 руб.',
  ]);
  const flat = (lines, name = 'Выписка ЕГРН.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nКадастровый номер: 77:01:0001001:4321\n${lines}`], name), id: name });
  const house = (lines, name = 'ЕГРН дом.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Здание\n${lines}`], name), id: name });
  const run = (egrn, fields = { object_type: 'flat' }) => runAutoChecks(['cad_value_match'], [report], { fields, service: 'realty', egrn });
  // Как в выписке (с копейками — округление до рубля и до «8,2 млн» не находка); удельный показатель, участок, аналог,
  // прежняя дата — не в счёт.
  assert.deepEqual(run([flat('Кадастровая стоимость, руб.: 8200000.40\nДата определения кадастровой стоимости: 01.01.2023')]).cad_value_match, []);
  // Число на следующей строке; «8,2 млн» сходится с 8 230 000 (с точностью записи), «8 200 000» — нет.
  assert.deepEqual(texts(run([flat('Кадастровая стоимость, руб.:\n8 230 000,00')]), 'cad_value_match'),
    ['Кадастровая стоимость 8 200 000 руб. не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (8 230 000 руб., стр. 1) — проверьте, не стоимость ли это другого объекта или прежней даты']);

  // Выписка — другая стоимость: находки с кнопкой к выписке и «Исправить в черновике»; «млн» — без замены.
  let res = run([flat('Кадастровая стоимость (по состоянию на 01.01.2023), руб.: 8 431 520,17')]);
  assert.deepEqual(texts(res, 'cad_value_match'), [
    'Кадастровая стоимость 8 200 000 руб. не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (8 431 520,17 руб. по состоянию на 01.01.2023, стр. 1) — проверьте, не стоимость ли это другого объекта или прежней даты',
    'Кадастровая стоимость 8,2 млн руб. не совпадает с выпиской ЕГРН «Выписка ЕГРН.pdf» (8 431 520,17 руб. по состоянию на 01.01.2023, стр. 1) — проверьте, не стоимость ли это другого объекта или прежней даты',
  ]);
  assert.equal(res.cad_value_match[0].egrn.bad, '8 200 000');
  assert.equal(res.cad_value_match[0].egrn.right, '8 431 520,17');
  assert.equal(res.cad_value_match[1].egrn.bad, undefined);
  assert.match(res.cad_value_match[0].egrn.quote, /Кадастровая стоимость/);
  // Та же дата в строке отчёта — сверяем; выписка на дом при оценке квартиры не в счёт; выписки спорят — молчим.
  res = run([flat('Кадастровая стоимость, руб.: 6 600 000\nДата определения кадастровой стоимости: 01.01.2021')]);
  assert.equal(texts(res, 'cad_value_match').length, 3);
  assert.deepEqual(run([flat('Площадь, м2: 47,3'), house('Кадастровая стоимость, руб.: 300000000')]).cad_value_match, []);
  assert.deepEqual(run([flat('Кадастровая стоимость, руб.: 8431520.17'), flat('Кадастровая стоимость, руб.: 9000000', 'Выписка-2.pdf')]).cad_value_match, []);
  assert.deepEqual(run([]).cad_value_match, []);
  // При оценке дома стоимость участка не сверяется с выпиской на дом.
  res = runAutoChecks(['cad_value_match'], [doc(['Кадастровая стоимость жилого дома: 4 000 000 руб.\nКадастровая стоимость земельного участка: 1 200 000 руб.'])],
    { fields: { object_type: 'house' }, service: 'realty', egrn: [house('Кадастровая стоимость, руб.: 4100000')] });
  assert.deepEqual(res.cad_value_match.map((f) => f.egrn.bad), ['4 000 000']);
});
test('2.264: номер и дата выписки ЕГРН в отчёте — как у выписки в деле', () => {
  const egrn = (head, name = 'Выписка ЕГРН.pdf') => ({ ...doc([`Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n${head}\nВид объекта недвижимости: Помещение\nПлощадь, м2: 47,3`], name), id: name });
  const flat = egrn('02.10.2026 № КУВИ-001/2026-12345678');
  const run = (pages, list = [flat]) => runAutoChecks(['egrn_doc_match'], [doc(pages)], { fields: { object_type: 'flat' }, service: 'realty', egrn: list });
  // Номер и дата как в деле (пробелы и тире любые, дата словами), имя файла в «…» и дата получения — не в счёт.
  assert.deepEqual(run(['Перечень использованных документов:\n1. Выписка из ЕГРН № КУВИ – 001/2026 – 12345678 от 2 октября 2026 г.\n2. Выписка из ЕГРН — файл «ЕГРН от 01.09.2026.pdf», получен 03.10.2026']).egrn_doc_match, []);
  // Та же выписка, другая дата — находка с кнопкой к выписке и заменой даты тем же видом.
  let res = run(['Перечень использованных документов:\n1. Выписка из ЕГРН № КУВИ-001/2026-12345678 от 01.09.2026; 2. Технический паспорт от 01.01.2001']);
  assert.deepEqual(texts(res, 'egrn_doc_match'), ['Дата выписки ЕГРН № КУВИ-001/2026-12345678 в отчёте — 01.09.2026, а у этой выписки в деле — 02.10.2026 («Выписка ЕГРН.pdf», стр. 1) — проверьте перечень документов']);
  assert.equal(res.egrn_doc_match[0].egrn.bad, '01.09.2026');
  assert.equal(res.egrn_doc_match[0].egrn.right, '02.10.2026');
  assert.match(res.egrn_doc_match[0].egrn.quote, /КУВИ-001\/2026-12345678/);
  res = run(['Выписка из ЕГРН от 1 сентября 2026 г. № КУВИ-001/2026-12345678']);
  assert.equal(res.egrn_doc_match[0].egrn.right, '2 октября 2026');
  // Номера нет в деле — находка; выписка в деле одна — замена номера.
  res = run(['Задание на оценку: выписка из ЕГРН № КУВИ-001/2025-99999999 от 02.10.2026']);
  assert.deepEqual(texts(res, 'egrn_doc_match'), ['Выписка ЕГРН № КУВИ-001/2025-99999999 в отчёте — в деле такой нет; в деле — № КУВИ-001/2026-12345678 от 02.10.2026 («Выписка ЕГРН.pdf», стр. 1) — проверьте, не номер ли это старой выписки или другого объекта']);
  assert.equal(res.egrn_doc_match[0].egrn.bad, 'КУВИ-001/2025-99999999');
  assert.equal(res.egrn_doc_match[0].egrn.right, 'КУВИ-001/2026-12345678');
  // Две выписки в деле — сверяется с той, у которой этот номер; чужого номера — без замены.
  const house = egrn('Дата формирования выписки: 05.10.2026\nНомер: КУВИ-001/2026-55555555', 'ЕГРН дом.pdf');
  assert.deepEqual(run(['Выписка ЕГРН № КУВИ-001/2026-55555555 от 05.10.2026; выписка ЕГРН № КУВИ-001/2026-12345678 от 02.10.2026'], [flat, house]).egrn_doc_match, []);
  res = run(['Выписка ЕГРН № КУВИ-001/2025-1111'], [flat, house]);
  assert.equal(res.egrn_doc_match.length, 1);
  assert.equal(res.egrn_doc_match[0].egrn, undefined);
  // Без номера: «Выписка из ЕГРН от …» — дата у одной из выписок дела; нет — находка с заменой (дата в деле одна).
  assert.deepEqual(run(['Выписка из Единого государственного реестра недвижимости от 02.10.2026']).egrn_doc_match, []);
  res = run(['Документы: выписка из ЕГРН от 15.08.2026, технический паспорт']);
  assert.deepEqual(texts(res, 'egrn_doc_match'), ['Выписка ЕГРН от 15.08.2026 в отчёте — в деле выписки от этого числа нет; в деле — № КУВИ-001/2026-12345678 от 02.10.2026 («Выписка ЕГРН.pdf», стр. 1) — проверьте перечень документов']);
  assert.equal(res.egrn_doc_match[0].egrn.right, '02.10.2026');
  // Не про выписку ЕГРН или без даты после «от» — молчим; в деле выписки без номера и даты — правило молчит.
  assert.deepEqual(run(['Выписка из домовой книги от 15.08.2026\nВыписка из ЕГРН получена от заказчика 15.08.2026']).egrn_doc_match, []);
  assert.deepEqual(run(['Выписка ЕГРН № КУВИ-001/2025-99999999'], [egrn('Без даты')]).egrn_doc_match, []);
  assert.deepEqual(run(['Выписка ЕГРН № КУВИ-001/2025-99999999'], []).egrn_doc_match, []);
  assert.ok(AUTO_CHECKS.egrn_doc_match);
});

// 2.277: адрес объекта — как в приложенном к делу задании на оценку (письме, определении суда): после выписки, раньше заявки.
test('2.277: адрес объекта — как в задании на оценку, если адрес в задании есть', () => {
  const report = doc(['ОТЧЁТ ОБ ОЦЕНКЕ\nАдрес объекта оценки: г. Москва, ул. Долевая, д. 3, кв. 8\nАналог 1: г. Москва, ул. Лесная, д. 5, кв. 1']);
  const task = (addr, name = 'Задание.pdf') => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nЗаказчик: ООО «Тест», юридический адрес: г. Москва, ул. Пушкина, д. 1\nОбъект оценки: квартира\nАдрес объекта: ${addr}\nДата оценки: 01.10.2026`], name);
  const flat = (addr) => doc([`Выписка из Единого государственного реестра недвижимости\nВид объекта недвижимости: Помещение\nАдрес (местоположение): ${addr}`], 'Выписка ЕГРН.pdf');
  const run = (ctx) => runAutoChecks(['address_match'], [report], { service: 'realty', fields: {}, ...ctx }).address_match;
  // Как в задании — не находка; адрес заказчика в задании не мешает.
  assert.deepEqual(run({ assignment: [task('г. Москва, ул. Долевая, д. 3, кв. 8')] }), []);
  // В задании другая квартира — находка, верное значение и откуда оно; заявка с опечаткой не мешает.
  const res = run({ assignment: [task('г. Москва, ул. Долевая, д. 3, кв. 18')], fields: { address: 'г. Москва, ул. Долевая, д. 3, кв. 8' } });
  assert.deepEqual(res.map((f) => f.text), [
    'Адрес «г. Москва, ул. Долевая, д. 3, кв. 8» не совпадает с адресом в задании на оценку «Задание.pdf» (г. Москва, ул. Долевая, д. 3, кв. 18, стр. 1): квартира 8, а в задании на оценку 18 — проверьте, нет ли данных другого объекта',
  ]);
  assert.deepEqual(res[0].fix, { bad: 'г. Москва, ул. Долевая, д. 3, кв. 8', right: 'г. Москва, ул. Долевая, д. 3, кв. 18', from: 'в задании на оценку «Задание.pdf»' });
  assert.ok(!res[0].egrn);
  // Отчёт как в задании, а в заявке другое — задание важнее заявки: находки нет.
  assert.deepEqual(run({ assignment: [task('г. Москва, ул. Долевая, д. 3, кв. 8')], fields: { address: 'г. Москва, ул. Долевая, д. 3, кв. 9' } }), []);
  // Выписка важнее задания: отчёт как в выписке — молчим; иначе находка по выписке.
  assert.deepEqual(run({ assignment: [task('г. Москва, ул. Долевая, д. 3, кв. 18')], egrn: [flat('г. Москва, ул. Долевая, д. 3, кв. 8')] }), []);
  assert.match(run({ assignment: [task('г. Москва, ул. Долевая, д. 3, кв. 8')], egrn: [flat('г. Москва, ул. Долевая, д. 3, кв. 28')] })[0].text, /в выписке ЕГРН/);
  // Два задания с разными адресами — какой верный, решает эксперт; выписка среди приложенных — не задание.
  assert.deepEqual(run({ assignment: [task('г. Москва, ул. Долевая, д. 3, кв. 18'), task('г. Москва, ул. Долевая, д. 3, кв. 28', 'Задание-2.pdf')] }), []);
  assert.deepEqual(run({ assignment: [flat('г. Москва, ул. Долевая, д. 3, кв. 18')] }), []);
  // В задании адреса нет — как раньше.
  assert.deepEqual(run({ assignment: [doc(['ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: 01.10.2026'], 'Задание.pdf')] }), []);
  // Определение суда — со своим названием.
  const court = doc(['ОПРЕДЕЛЕНИЕ о назначении судебной экспертизы\nМещанский районный суд г. Москвы, расположенный по адресу: г. Москва, ул. Каланчёвская, д. 43, определил: определить рыночную стоимость квартиры, расположенной по адресу: г. Москва, ул. Долевая, д. 3, кв. 18.'], 'Определение.pdf');
  assert.match(run({ assignment: [court] })[0]?.text ?? '', /с адресом в определении суда «Определение\.pdf» \(г\. Москва, ул\. Долевая, д\. 3, кв\. 18, стр\. 1\): квартира 8, а в определении суда 18/);
});

// 2.278: вид стоимости — как в приложенном к делу задании на оценку (письме заказчика, определении суда).
test('2.278: вид стоимости в отчёте — как в задании на оценку', () => {
  const report = (kind) => doc([`ОТЧЁТ ОБ ОЦЕНКЕ № 7\nВид определяемой стоимости: ${kind}\nДата оценки: 01.10.2026`, `Итог: ${kind} стоимость квартиры составляет 9 000 000 руб.`]);
  const task = (kind, name = 'Задание.pdf') => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nВид стоимости: ${kind}\nДата оценки: 01.10.2026`], name);
  const run = (rep, ...assignment) => runAutoChecks(['purpose_value'], [rep], { fields: {}, service: 'realty', assignment }).purpose_value;
  assert.deepEqual(run(report('рыночная'), task('рыночная')), [], 'как в задании');
  assert.deepEqual(run(report('рыночная'), task('Рыночная стоимость')), [], 'регистр и слово «стоимость» не мешают');

  const res = run(report('ликвидационная'), task('рыночная'));
  assert.deepEqual(res.map((f) => f.text), [
    'Вид стоимости в отчёте — «ликвидационная», а в задании на оценку «Задание.pdf» — «рыночная» (стр. 1); вид стоимости берётся из задания — исправьте отчёт или приложите к делу новое задание',
  ]);
  assert.deepEqual(res[0].fix, { bad: 'ликвидационная', right: 'рыночная', from: 'в задании на оценку «Задание.pdf»', flip: 'value' });
  assert.equal(res[0].quote, 'Вид определяемой стоимости: ликвидационная');
  // Замена в черновике — та же форма слова.
  assert.equal(swapValue(res[0].fix, 'ликвидационной'), 'рыночной');
  assert.equal(swapValue(res[0].fix, 'Ликвидационная'), 'Рыночная');
  assert.equal(swapValue(res[0].fix, 'ЛИКВИДАЦИОННАЯ'), 'РЫНОЧНАЯ');

  // В задании два вида (Сбер: рыночная и ликвидационная), в отчёте одна — находка без замены одной кнопкой.
  const two = run(report('рыночная'), task('рыночная и ликвидационная'));
  assert.match(two[0].text, /в отчёте — «рыночная», а в задании на оценку «Задание\.pdf» — «рыночная и ликвидационная»/);
  assert.equal(two[0].fix.flip, undefined);
  assert.equal(swapValue(two[0].fix), null);

  // Определение суда без строки «вид стоимости» — по словам «определить … стоимость»; кадастровая в письме — не вид.
  const court = doc(['ОПРЕДЕЛЕНИЕ о назначении судебной экспертизы\nМещанский районный суд г. Москвы определил: определить рыночную стоимость квартиры. Кадастровая стоимость квартиры — 7 000 000 руб.'], 'Определение.pdf');
  assert.deepEqual(run(report('рыночная'), court), []);
  assert.match(run(report('ликвидационная'), court)[0].text, /а в определении суда «Определение\.pdf» — «рыночная»/);
  // Два задания с разными видами — молчим; вида в задании нет — молчим; выписка ЕГРН с кадастровой — не задание.
  assert.deepEqual(run(report('ликвидационная'), task('рыночная'), task('ликвидационная', 'Задание-2.pdf')), []);
  assert.deepEqual(run(report('ликвидационная'), doc(['ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: 01.10.2026'], 'Задание.pdf')), []);
  assert.deepEqual(run(report('ликвидационная'), doc(['Выписка из Единого государственного реестра недвижимости\nВид стоимости: кадастровая'], 'Выписка ЕГРН.pdf')), []);
  // В самом отчёте виды уже расходятся — одна находка «один во всём отчёте», с заданием не сверяем.
  const mixed = doc(['Вид стоимости: рыночная', 'Вид стоимости: ликвидационная', 'Вид стоимости: рыночная']);
  assert.ok(run(mixed, task('инвестиционная')).every((f) => !/в задании/.test(f.text)));
});
// 2.287: цель оценки — как в приложенном к делу задании на оценку (письме заказчика, определении суда); задание важнее заявки.
test('2.287: цель оценки в отчёте — как в задании на оценку', () => {
  const report = (goal) => doc([`ОТЧЁТ ОБ ОЦЕНКЕ № 7\nЦель оценки: ${goal}\nВид определяемой стоимости: рыночная`]);
  const task = (goal, name = 'Задание.pdf') => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nЦель оценки: ${goal}\nВид стоимости: рыночная`], name);
  const run = (rep, fields, ...assignment) => runAutoChecks(['purpose_value'], [rep], { fields, service: 'realty', assignment }).purpose_value;
  assert.deepEqual(run(report('для совершения сделки купли-продажи'), {}, task('для совершения сделки купли-продажи')), [], 'как в задании');
  assert.deepEqual(run(report('для предоставления в банк при ипотеке'), {}, task('для совершения сделки купли-продажи')), [], 'совместимые цели не в счёт');

  const res = run(report('для предоставления в суд'), {}, task('для совершения сделки купли-продажи'));
  assert.deepEqual(res.map((f) => f.text), [
    'Цель оценки в отчёте — «для предоставления в суд» (для суда), а в задании на оценку «Задание.pdf» — «для совершения сделки купли-продажи» (стр. 1); цель берётся из задания — исправьте отчёт или приложите к делу новое задание',
  ]);
  assert.equal(res[0].quote, 'Цель оценки: для предоставления в суд');
  // 2.293: цель целиком меняется на цель из задания.
  assert.deepEqual(res[0].fix, { bad: 'для предоставления в суд', right: 'для совершения сделки купли-продажи', from: 'в задании на оценку «Задание.pdf»', flip: 'text' });
  // Задание важнее заявки: отчёт как в задании, а в заявке другое — находки нет; не как в задании — одна находка, по заданию.
  assert.deepEqual(run(report('для совершения сделки купли-продажи'), { purpose: 'inheritance' }, task('для совершения сделки купли-продажи')), []);
  const both = run(report('для предоставления в банк'), { purpose: 'court' }, task('для оформления наследства у нотариуса'));
  assert.equal(both.filter((f) => /^Цель оценки/.test(f.text)).length, 1);
  assert.match(both[0].text, /а в задании на оценку «Задание\.pdf» — «для оформления наследства у нотариуса»/);
  // Определение суда без строки «цель оценки» — цель «для суда».
  const court = doc(['ОПРЕДЕЛЕНИЕ о назначении судебной экспертизы\nМещанский районный суд г. Москвы определил: определить рыночную стоимость квартиры.'], 'Определение.pdf');
  assert.deepEqual(run(report('для предоставления в суд'), {}, court), []);
  assert.match(run(report('для совершения сделки купли-продажи'), {}, court)[0].text, /а в определении суда «Определение\.pdf» — «для суда» \(стр\. 1\)/);
  // Два задания с разными целями — молчим, сверка с заявкой как раньше; цели в задании нет — как раньше, с заявкой.
  assert.deepEqual(run(report('для предоставления в суд'), {}, task('для совершения сделки купли-продажи'), task('для оформления наследства', 'Задание-2.pdf')), []);
  assert.match(run(report('для предоставления в суд'), { purpose: 'deal' }, doc(['ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: 01.10.2026'], 'Задание.pdf'))[0].text, /а в заявке — «купля-продажа»/);
  // Выписка ЕГРН — не задание.
  assert.deepEqual(run(report('для предоставления в суд'), {}, doc(['Выписка из Единого государственного реестра недвижимости\nЦель оценки: для продажи'], 'Выписка ЕГРН.pdf')), []);
});


// 2.288: заказчик оценки — как в приложенном к делу задании на оценку (письме заказчика), а без него — как в заявке.
test('2.288: заказчик в отчёте — как в задании на оценку и заявке', () => {
  const report = (who) => doc([`ОТЧЁТ ОБ ОЦЕНКЕ № 7\nЗаказчик: ${who}\nЦель оценки: для продажи`, `СВЕДЕНИЯ О ЗАКАЗЧИКЕ\nЗаказчик — лицо, заключившее договор на проведение оценки.\nЗаказчик оценки: ${who}, паспорт 4500 000000`]);
  const task = (who, name = 'Задание.pdf') => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nЗаказчик: ${who}, ИНН 770000000000\nВид стоимости: рыночная`], name);
  const run = (rep, ctx, ...assignment) => runAutoChecks(['customer_match'], [rep], { service: 'realty', fields: {}, assignment, ...ctx }).customer_match;
  // Падеж фамилии и инициалы вместо имени — тот же человек; определение «Заказчик — лицо, …» не в счёт.
  assert.deepEqual(run(report('Иванов Иван Иванович'), {}, task('Иванов И.И.')), []);
  assert.deepEqual(run(report('гражданин Иванова Ивана Ивановича'), {}, task('Иванов Иван Иванович')), []);
  const res = run(report('Петров Пётр Петрович'), {}, task('Иванов Иван Иванович'));
  assert.deepEqual(res.map((f) => f.text), [
    'Заказчик в отчёте — «Петров Пётр Петрович», а в задании на оценку «Задание.pdf» — «Иванов Иван Иванович» (стр. 1); заказчик берётся из задания — исправьте отчёт или приложите к делу новое задание',
    'Заказчик в отчёте — «Петров Пётр Петрович», а в задании на оценку «Задание.pdf» — «Иванов Иван Иванович» (стр. 1); заказчик берётся из задания — исправьте отчёт или приложите к делу новое задание',
  ]);
  assert.equal(res[0].quote, 'Заказчик: Петров Пётр Петрович');
  // 2.294: заказчик меняется на заказчика из задания как есть (`flip: 'name'`).
  assert.deepEqual(res[0].fix, { bad: 'Петров Пётр Петрович', right: 'Иванов Иван Иванович', from: 'в задании на оценку «Задание.pdf»', flip: 'name' });
  const long = `ООО «${'Очень длинное название '.repeat(6).trim()}»`;
  assert.equal(run(report(long), {}, task('Иванов Иван Иванович'))[0].fix.flip, undefined, 'длинный заказчик — без замены одной кнопкой');
  // Та же фамилия, другое имя — другой человек.
  assert.equal(run(report('Иванов Сергей Иванович'), {}, task('Иванов Иван Иванович')).length, 2);
  // Организации — по названию в кавычках; человек вместо организации — находка.
  assert.deepEqual(run(report('ООО «Ромашка»'), {}, task('Общество с ограниченной ответственностью «Ромашка»')), []);
  assert.equal(run(report('ООО «Лютик»'), {}, task('ООО «Ромашка»')).length, 2);
  assert.equal(run(report('Иванов Иван Иванович'), {}, task('ООО «Ромашка»')).length, 2);
  // Задание важнее заявки: в заявке другой человек — по заданию находки нет.
  assert.deepEqual(run(report('Иванов Иван Иванович'), { customer: 'Сидоров Семён' }, task('Иванов Иван Иванович')), []);
  // Задания с разными заказчиками — молчим; определение суда — суд не заказчик, молчим.
  assert.deepEqual(run(report('Петров Пётр'), {}, task('Иванов Иван'), task('Сидоров Семён', 'Задание-2.pdf')), []);
  const court = doc(['ОПРЕДЕЛЕНИЕ о назначении судебной экспертизы\nМещанский районный суд г. Москвы определил: определить рыночную стоимость квартиры.'], 'Определение.pdf');
  assert.deepEqual(run(report('Петров Пётр'), { customer: 'Иванов Иван' }, court), []);
  // Без задания — с заявкой (владелец заявки), только когда в отчёте человек; цель «для суда» — не сверяем.
  assert.match(run(report('Петров Пётр Петрович'), { customer: 'Иванов Иван' })[0].text, /^Заказчик в отчёте — «Петров Пётр Петрович», а в заявке — «Иванов Иван»: проверьте заказчика; если он другой — приложите к делу задание на оценку$/);
  assert.equal(run(report('Петров Пётр Петрович'), { customer: 'Иванов Иван' })[0].fix, undefined);
  assert.deepEqual(run(report('Иванов Иван Иванович'), { customer: 'Иванов Иван' }), []);
  assert.deepEqual(run(report('ООО «Ромашка»'), { customer: 'Иванов Иван' }), [], 'представитель организации');
  assert.deepEqual(run(report('Петров Пётр'), { customer: 'Иванов Иван', fields: { purpose: 'court' } }), []);
  assert.deepEqual(run(report('[заполнить]'), { customer: 'Иванов Иван' }), []);
  // Не оценка — не сверяем; выписка ЕГРН — не задание.
  assert.deepEqual(run(report('Петров Пётр'), { service: 'handwriting', customer: 'Иванов Иван' }), []);
  assert.deepEqual(run(report('Петров Пётр'), {}, doc(['Выписка из Единого государственного реестра недвижимости\nЗаказчик: Иванов Иван'], 'Выписка ЕГРН.pdf')), []);
});

// 2.307: при оценке для банка предполагаемый пользователь результатов оценки — банк из заявки или из задания на оценку.
test('2.307: оценка для банка — пользователь результатов оценки — банк из заявки', () => {
  const report = (user) => doc([`ОТЧЁТ ОБ ОЦЕНКЕ № 7\nЦель оценки: для залога\n${user === null ? '' : `Предполагаемый пользователь результатов оценки: ${user}`}\nВид стоимости: рыночная`]);
  const task = (user, name = 'Задание.pdf') => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nЦель оценки: для ипотечного кредитования\nПредполагаемые пользователи результатов оценки и отчёта: ${user}`], name);
  const run = (rep, fields, ...assignment) => runAutoChecks(['bank_user'], [rep], { service: 'realty', fields, assignment }).bank_user;
  const sber = { purpose: 'bank', bank: 'sber' };
  // Сбербанк в заявке — в отчёте Сбербанк (и с заказчиком вместе) — без находки.
  assert.deepEqual(run(report('ПАО Сбербанк'), sber), []);
  assert.deepEqual(run(report('Заказчик и ПАО «Сбербанк России»'), sber), []);
  // Другой банк — находка с заменой на «ПАО Сбербанк».
  const res = run(report('Банк ВТБ (ПАО)'), sber);
  assert.equal(res.length, 1);
  assert.equal(res[0].text, 'Предполагаемый пользователь в отчёте — «Банк ВТБ (ПАО)», а в заявке банк — «Сбербанк»: при оценке для банка пользователь результатов — этот банк; исправьте отчёт');
  assert.deepEqual(res[0].fix, { bad: 'Банк ВТБ (ПАО)', right: 'ПАО Сбербанк', from: 'в заявке', flip: 'name' });
  assert.equal(res[0].quote, 'Предполагаемый пользователь результатов оценки: Банк ВТБ (ПАО)');
  // Только заказчик — тоже находка.
  assert.equal(run(report('Заказчик'), sber).length, 1);
  // Пользователь не указан вовсе — находка.
  assert.deepEqual(run(report(null), sber).map((f) => f.text), ['В отчёте не указан предполагаемый пользователь результатов оценки — оценка для банка: укажите пользователем банк — ПАО Сбербанк']);
  // «Другой банк» в заявке: банк из задания на оценку.
  const other = { purpose: 'bank', bank: 'other' };
  assert.deepEqual(run(report('Банк ВТБ (ПАО)'), other, task('Банк ВТБ (ПАО)')), []);
  const byTask = run(report('АО «Альфа-Банк»'), other, task('Банк ВТБ (ПАО)'));
  assert.match(byTask[0].text, /в задании на оценку «Задание\.pdf» — «Банк ВТБ \(ПАО\)» \(стр\. 1\)/);
  assert.equal(byTask[0].fix.from, 'в задании на оценку «Задание.pdf»');
  // Без задания: Сбербанк при «другом банке» — проверить; не банк — назвать банк; какой-то банк — молчим.
  assert.match(run(report('ПАО Сбербанк'), other)[0].text, /другой банк, не Сбербанк/);
  assert.match(run(report('Заказчик оценки'), other)[0].text, /назовите пользователем банк/);
  assert.equal(run(report('Заказчик оценки'), other)[0].fix, undefined);
  assert.deepEqual(run(report('АО «Газпромбанк»'), other), []);
  // Банк не выбран, цель «банк» из задания: банк из задания.
  assert.equal(run(report('Заказчик'), {}, task('ПАО Сбербанк')).length, 1);
  // Цель не «банк» — не сверяем; не оценка — не сверяем.
  assert.deepEqual(run(report('Заказчик'), { purpose: 'deal' }), []);
  assert.deepEqual(runAutoChecks(['bank_user'], [report('Заказчик')], { service: 'handwriting', fields: sber }).bank_user, []);
});
