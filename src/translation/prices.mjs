// Модуль «Переводы» (задача штаба 3f617197, решение Дамира 11.10.2026): цены и правила — настройками, в одной таблице.
// Стартовые цены — от Дамира; меняются здесь (через разработку), нотариальные тарифы Москвы обновлять в январе.
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
  const tiers = TRANSLATION_PRICES.notary.equivalence;
  for (let p = 1; p <= pages; p += 1) kop += [...tiers].reverse().find((t) => p >= t.from).kop;
  return kop;
}

const whole = (v, min = 0) => (Number.isInteger(v) && v >= min ? v : null);

// Предварительный расчёт по полям заявки: строки (услуги и транзит отдельно), итог и деление.
// null — данных для расчёта не хватает (нет числа страниц или документов).
export function quoteTranslation(serviceId, fields = {}) {
  const P = TRANSLATION_PRICES;
  const pages = whole(fields.pages, 1);
  const docs = whole(fields.docs ?? 1, 1);
  if (!pages || !docs || !['notary_paper', 'notary_file', 'plain'].includes(serviceId)) return null;
  const eastern = EASTERN_LANGUAGES.includes(fields.language);
  const lines = [];
  const add = (kind, title, kop) => { if (kop > 0) lines.push({ kind, title, kop }); };

  add('service', `Перевод: ${pages} стр. × ${rubShort(P.page_kop * (eastern ? P.eastern_factor : 1))}${eastern ? ' (восточный язык ×2)' : ''}`,
    pages * P.page_kop * (eastern ? P.eastern_factor : 1));
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
  if (serviceId === 'notary_file' && fields.doc_kind === 'identity' && !TRANSLATION_RULES.file_for_identity) {
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
