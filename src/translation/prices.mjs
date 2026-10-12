// Модуль «Переводы» (задача штаба 3f617197, решение Дамира 11.10.2026): цены и правила — настройками, в одной таблице.
// Стартовые цены — от Дамира; администратор правит их в кабинете («Управление» → «Цены и правила перевода», задача 2а.9) —
// сохранённое лежит в module_settings и действует вместо значений ниже; нотариальные тарифы Москвы обновлять в январе.
// Деньги — в копейках. Вознаграждение платформы — 20% только от услуг (перевод, срочность, организация заверения,
// сертификат); тарифы нотариуса и доставка — транзитом, без комиссии.
// Описание услуг и полей заявки — src/modules/translation.mjs.

export const TRANSLATION_PRICES = Object.freeze({
  page_kop: 600_00, // перевод, за страницу (личный документ до 1 800 знаков — 1 страница)
  eastern_factor: 2, // восточные языки — перевод ×2
  urgent_kop: 1_000_00, // срочно (В1 — 1–2 дня, В3 — день в день; у В2 срочности нет), за заказ
  organize_kop: 400_00, // организация нотариального заверения, за документ
  organize_batch_kop: 250_00, // то же, если документов в заказе от organize_batch_from
  organize_batch_from: 5,
  certificate_kop: 150_00, // сертификат платформы (В3), за документ
  notary: Object.freeze({ // нотариальные тарифы Москвы 2026, транзитом
    signature_kop: 400_00, // свидетельствование подписи переводчика, за документ
    copy_page_kop: 150_00, // копия оригинала, за страницу
    // Равнозначность электронного документа (ст. 103.8): за страницу копии и перевода; с 15-й — 230 ₽, с 35-й — 200 ₽.
    equivalence: Object.freeze([{ from: 1, kop: 250_00 }, { from: 15, kop: 230_00 }, { from: 35, kop: 200_00 }]),
  }),
  courier_kop: 500_00, // доставка курьером по Москве, транзитом
  commission_percent: 20,
});

// Правила (настройки).
export const TRANSLATION_RULES = Object.freeze({
  // В2 для документов, удостоверяющих личность: выключено до ответа нотариуса-партнёра.
  file_for_identity: false,
  // Вычитка (2а.7): обязательна, пока у переводчика сдано (проверено) меньше переводов, чем proofread_new_orders;
  // остальным — выборочно, примерно каждый proofread_sample_percent-й перевод. После замечания заказчика — всегда.
  proofread_new_orders: 3,
  proofread_sample_percent: 10,
  // Бесплатная переделка по замечанию заказчика: срок — не раньше чем через redo_days дней от просьбы.
  redo_days: 2,
});

// Что администратор правит в кабинете (2а.9): плоский список; деньги — в копейках. Вознаграждение платформы (20%, устав) —
// не настройка. Поля из списка ниже читаются расчётом через currentPrices() / currentRules().
const P0 = TRANSLATION_PRICES;
const [EQ1, EQ2, EQ3] = P0.notary.equivalence;
export const SETTING_FIELDS = Object.freeze([
  { key: 'page_kop', group: 'Перевод', title: 'Перевод, за страницу', kind: 'rub', min: 100, def: P0.page_kop },
  { key: 'eastern_factor', group: 'Перевод', title: 'Восточные языки — во сколько раз дороже', kind: 'factor', min: 1, max: 5, def: P0.eastern_factor },
  { key: 'urgent_kop', group: 'Перевод', title: 'Срочно, за заказ', kind: 'rub', def: P0.urgent_kop },
  { key: 'organize_kop', group: 'Услуги платформы', title: 'Организация нотариального заверения, за документ', kind: 'rub', def: P0.organize_kop },
  { key: 'organize_batch_kop', group: 'Услуги платформы', title: 'То же в пачке, за документ', kind: 'rub', def: P0.organize_batch_kop },
  { key: 'organize_batch_from', group: 'Услуги платформы', title: 'Пачка — от скольких документов в заказе', kind: 'int', min: 2, max: 100, def: P0.organize_batch_from },
  { key: 'certificate_kop', group: 'Услуги платформы', title: 'Сертификат платформы (без нотариуса), за документ', kind: 'rub', def: P0.certificate_kop },
  { key: 'notary_signature_kop', group: 'Нотариус (без наценки)', title: 'Подпись переводчика, за документ', kind: 'rub', def: P0.notary.signature_kop },
  { key: 'notary_copy_page_kop', group: 'Нотариус (без наценки)', title: 'Копия оригинала, за страницу', kind: 'rub', def: P0.notary.copy_page_kop },
  { key: 'equivalence_kop', group: 'Нотариус (без наценки)', title: 'Равнозначность файла, за страницу', kind: 'rub', def: EQ1.kop },
  { key: 'equivalence2_from', group: 'Нотариус (без наценки)', title: 'Равнозначность — вторая цена со страницы №', kind: 'int', min: 2, max: 1000, def: EQ2.from },
  { key: 'equivalence2_kop', group: 'Нотариус (без наценки)', title: 'Равнозначность — вторая цена, за страницу', kind: 'rub', def: EQ2.kop },
  { key: 'equivalence3_from', group: 'Нотариус (без наценки)', title: 'Равнозначность — третья цена со страницы №', kind: 'int', min: 3, max: 1000, def: EQ3.from },
  { key: 'equivalence3_kop', group: 'Нотариус (без наценки)', title: 'Равнозначность — третья цена, за страницу', kind: 'rub', def: EQ3.kop },
  { key: 'courier_kop', group: 'Доставка (без наценки)', title: 'Курьер по Москве, за заказ', kind: 'rub', def: P0.courier_kop },
  { key: 'file_for_identity', group: 'Правила', title: 'Паспорт можно заказать нотариальным файлом', kind: 'bool', def: TRANSLATION_RULES.file_for_identity },
  { key: 'proofread_new_orders', group: 'Правила', title: 'Вычитка обязательна, пока у переводчика сдано меньше переводов', kind: 'int', min: 0, max: 100, def: TRANSLATION_RULES.proofread_new_orders },
  { key: 'proofread_sample_percent', group: 'Правила', title: 'Вычитка остальных — процент переводов', kind: 'int', min: 0, max: 100, def: TRANSLATION_RULES.proofread_sample_percent },
  { key: 'redo_days', group: 'Правила', title: 'Бесплатная переделка — срок, дней', kind: 'int', min: 1, max: 30, def: TRANSLATION_RULES.redo_days },
]);
const MAX_KOP = 1_000_000_00; // 1 млн ₽ — защита от лишнего нуля

export const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, f.def])));

function pricesFrom(v) {
  return {
    ...P0,
    page_kop: v.page_kop, eastern_factor: v.eastern_factor, urgent_kop: v.urgent_kop, organize_kop: v.organize_kop,
    organize_batch_kop: v.organize_batch_kop, organize_batch_from: v.organize_batch_from, certificate_kop: v.certificate_kop,
    courier_kop: v.courier_kop,
    notary: {
      signature_kop: v.notary_signature_kop, copy_page_kop: v.notary_copy_page_kop,
      equivalence: [{ from: 1, kop: v.equivalence_kop }, { from: v.equivalence2_from, kop: v.equivalence2_kop }, { from: v.equivalence3_from, kop: v.equivalence3_kop }],
    },
  };
}
const rulesFrom = (v) => ({ file_for_identity: v.file_for_identity, proofread_new_orders: v.proofread_new_orders, proofread_sample_percent: v.proofread_sample_percent, redo_days: v.redo_days });

// Проверка того, что прислал администратор: { key: значение } поверх текущих; ошибка — Error с понятным текстом (msg).
// Неизвестные ключи — ошибка; значения — в копейках, целые.
export function settingsFrom(body, base = DEFAULT_SETTINGS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw settingsError('Нет значений');
  const out = { ...base };
  for (const [k, v] of Object.entries(body)) {
    const f = SETTING_FIELDS.find((x) => x.key === k);
    if (!f) throw settingsError(`Неизвестная настройка «${k}»`);
    if (f.kind === 'bool') {
      if (typeof v !== 'boolean') throw settingsError(`«${f.title}»: да или нет`);
    } else if (f.kind === 'factor') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < f.min || v > f.max || Math.round(v * 10) !== v * 10) {
        throw settingsError(`«${f.title}»: число от ${f.min} до ${f.max}, не больше одного знака после запятой`);
      }
    } else if (f.kind === 'rub') {
      if (!Number.isInteger(v) || v < (f.min ?? 0) || v > MAX_KOP) throw settingsError(`«${f.title}»: сумма от ${rubShort(f.min ?? 0)} до ${rubShort(MAX_KOP)}`);
    } else if (!Number.isInteger(v) || v < f.min || v > f.max) throw settingsError(`«${f.title}»: целое от ${f.min} до ${f.max}`);
    out[k] = v;
  }
  if (out.equivalence3_from <= out.equivalence2_from) throw settingsError('Равнозначность: третья цена должна начинаться позже второй');
  return out;
}
function settingsError(msg) { const e = new Error(msg); e.settings = true; return e; }

// Действующие значения — в памяти процесса; обновляет src/translation/settings.mjs из module_settings.
let current = { values: DEFAULT_SETTINGS, prices: pricesFrom(DEFAULT_SETTINGS), rules: rulesFrom(DEFAULT_SETTINGS) };
export function applySettings(saved) {
  const values = saved ? settingsFrom(Object.fromEntries(Object.entries(saved).filter(([k]) => SETTING_FIELDS.some((f) => f.key === k)))) : DEFAULT_SETTINGS;
  current = { values, prices: pricesFrom(values), rules: rulesFrom(values) };
}
export const currentSettings = () => current.values;
export const currentPrices = () => current.prices;
export const currentRules = () => current.rules;

// Восточные языки — перевод ×2.
export const EASTERN_LANGUAGES = Object.freeze(['zh', 'ja', 'ko', 'ar', 'fa', 'he', 'hi', 'vi', 'th']);

// Получатели, которые обычно требуют нотариальный перевод: основание — для подсказки клиенту.
export const NOTARY_RECIPIENTS = Object.freeze({
  mvd: 'МВД и миграционная служба (приказ МВД № 417, п. 47)',
  zags: 'ЗАГС (143-ФЗ, ст. 7)',
  court: 'суд (АПК РФ, ст. 255; ГПК РФ, ст. 408)',
  tax: 'налоговая (для физических лиц)',
  notary: 'нотариус',
  university: 'вуз в России',
  bank: 'банк — уточните у банка',
});

const NOTARIAL = ['notary_paper', 'notary_file'];

function equivalenceKop(pages) {
  let kop = 0;
  const tiers = currentPrices().notary.equivalence;
  for (let p = 1; p <= pages; p += 1) kop += [...tiers].reverse().find((t) => p >= t.from).kop;
  return kop;
}

const whole = (v, min = 0) => (Number.isInteger(v) && v >= min ? v : null);

// Предварительный расчёт по полям заявки: строки (услуги и транзит отдельно), итог и деление.
// null — данных для расчёта не хватает (нет числа страниц или документов).
export function quoteTranslation(serviceId, fields = {}) {
  const P = currentPrices();
  const pages = whole(fields.pages, 1);
  const docs = whole(fields.docs ?? 1, 1);
  if (!pages || !docs || !['notary_paper', 'notary_file', 'plain'].includes(serviceId)) return null;
  const eastern = EASTERN_LANGUAGES.includes(fields.language);
  const lines = [];
  const add = (kind, title, kop) => { if (kop > 0) lines.push({ kind, title, kop }); };

  const page = Math.round(P.page_kop * (eastern ? P.eastern_factor : 1));
  add('service', `Перевод: ${pages} стр. × ${rubShort(page)}${eastern ? ` (восточный язык ×${String(P.eastern_factor).replace('.', ',')})` : ''}`, pages * page);
  if (fields.urgent === 'yes') add('service', 'Срочно', P.urgent_kop);
  if (NOTARIAL.includes(serviceId)) {
    const each = docs >= P.organize_batch_from ? P.organize_batch_kop : P.organize_kop;
    add('service', `Организация нотариального заверения: ${docs} док. × ${rubShort(each)}`, docs * each);
    add('transit', `Нотариус — подпись переводчика: ${docs} док. × ${rubShort(P.notary.signature_kop)}`, docs * P.notary.signature_kop);
    add('transit', `Нотариус — копия оригинала: ${pages} стр. × ${rubShort(P.notary.copy_page_kop)}`, pages * P.notary.copy_page_kop);
  }
  if (serviceId === 'notary_file') {
    // Электронный документ — копия оригинала и перевод: страниц вдвое больше, чем в оригинале.
    add('transit', `Нотариус — равнозначность электронного документа: ${pages * 2} стр.`, equivalenceKop(pages * 2));
  }
  if (serviceId === 'plain') add('service', `Сертификат платформы: ${docs} док. × ${rubShort(P.certificate_kop)}`, docs * P.certificate_kop);
  if (fields.delivery === 'courier') add('transit', 'Доставка курьером по Москве', P.courier_kop);

  const servicesKop = lines.filter((l) => l.kind === 'service').reduce((s, l) => s + l.kop, 0);
  const transitKop = lines.filter((l) => l.kind === 'transit').reduce((s, l) => s + l.kop, 0);
  const commissionKop = Math.round((servicesKop * P.commission_percent) / 100);
  return {
    lines,
    total_kop: servicesKop + transitKop,
    services_kop: servicesKop,
    transit_kop: transitKop,
    commission_kop: commissionKop,
    executor_kop: servicesKop - commissionKop,
    commission_percent: P.commission_percent,
  };
}

// Предупреждения к заявке: получатель обычно требует нотариальный перевод, а выбран без нотариуса.
export function translationNotices(serviceId, fields = {}) {
  const out = [];
  const why = NOTARY_RECIPIENTS[fields.recipient];
  if (serviceId === 'plain' && why) {
    out.push({
      id: 'notary_needed',
      text: `Куда подаёте: ${why} — там обычно принимают только нотариальный перевод. Выберите «Нотариальный перевод (бумага)» или «(электронный файл)». Перевод без нотариуса подойдёт для бизнеса, бухгалтерии, ВЭД и части зарубежных получателей; если получатель его не примет, деньги за это не возвращаются.`,
    });
  }
  if (serviceId === 'notary_file' && fields.doc_kind === 'identity' && !currentRules().file_for_identity) {
    out.push({ id: 'file_identity', text: 'Паспорт и другие документы, удостоверяющие личность, пока заверяются только на бумаге: выберите «Нотариальный перевод (бумага)».' });
  }
  return out;
}

// Чего не хватает для отправки заявки на перевод (кроме обязательных полей): то, что нельзя заказать.
export function translationSubmitProblems(serviceId, fields = {}) {
  return translationNotices(serviceId, fields).filter((n) => n.id === 'file_identity').map(() => 'нотариальный перевод паспорта — только на бумаге');
}

function rubShort(kop) {
  return `${(kop / 100).toLocaleString('ru-RU')} ₽`;
}
