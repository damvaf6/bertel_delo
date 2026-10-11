// Модуль «Переводы» — описание данными: три услуги, поля заявки, список ИИ-проверок (задача штаба 3f617197,
// решение Дамира 11.10.2026: встраивать все три услуги сразу, не дожидаясь нотариусов). Цены и правила (что требует
// нотариального перевода, В2 для паспортов) — src/translation/prices.mjs. Формат — src/modules/index.mjs.

const DELIVERY_PAPER = {
  id: 'delivery', label: 'Как получить бумажный перевод', type: 'select', required: true,
  options: [
    { id: 'pickup', name: 'Заберу сам' },
    { id: 'courier', name: 'Курьером по Москве' },
    { id: 'post', name: 'Почтой' },
  ],
};
const ORIGINAL = {
  id: 'original', label: 'Как передадите оригинал', type: 'select', required: true,
  hint: 'Нотариус подшивает перевод к копии оригинала: нужен оригинал или его нотариальная копия',
  options: [
    { id: 'courier', name: 'Курьером' },
    { id: 'meeting', name: 'При встрече' },
    { id: 'notarial_copy', name: 'Есть нотариальная копия' },
  ],
};

export default {
  id: 'translation',
  name: 'Переводы',
  basis: ['contract'],

  fields: [
    {
      id: 'recipient', label: 'Куда подаёте перевод', type: 'select', required: true,
      options: [
        { id: 'mvd', name: 'МВД, миграционная служба' },
        { id: 'zags', name: 'ЗАГС' },
        { id: 'court', name: 'Суд' },
        { id: 'tax', name: 'Налоговая (для физического лица)' },
        { id: 'notary', name: 'Нотариус' },
        { id: 'university', name: 'Вуз в России' },
        { id: 'bank', name: 'Банк' },
        { id: 'business', name: 'Бухгалтерия, ВЭД, организация' },
        { id: 'abroad', name: 'За рубеж' },
        { id: 'personal', name: 'Для себя' },
        { id: 'other', name: 'Другое' },
      ],
    },
    {
      id: 'language', label: 'Язык (кроме русского)', type: 'select', required: true,
      options: [
        { id: 'en', name: 'Английский' }, { id: 'de', name: 'Немецкий' }, { id: 'fr', name: 'Французский' },
        { id: 'es', name: 'Испанский' }, { id: 'it', name: 'Итальянский' }, { id: 'pt', name: 'Португальский' },
        { id: 'uk', name: 'Украинский' }, { id: 'be', name: 'Белорусский' }, { id: 'kk', name: 'Казахский' },
        { id: 'uz', name: 'Узбекский' }, { id: 'tg', name: 'Таджикский' }, { id: 'ky', name: 'Киргизский' },
        { id: 'az', name: 'Азербайджанский' }, { id: 'hy', name: 'Армянский' }, { id: 'ka', name: 'Грузинский' },
        { id: 'tr', name: 'Турецкий' }, { id: 'pl', name: 'Польский' },
        { id: 'zh', name: 'Китайский' }, { id: 'ja', name: 'Японский' }, { id: 'ko', name: 'Корейский' },
        { id: 'ar', name: 'Арабский' }, { id: 'fa', name: 'Персидский (фарси)' }, { id: 'he', name: 'Иврит' },
        { id: 'hi', name: 'Хинди' }, { id: 'vi', name: 'Вьетнамский' }, { id: 'th', name: 'Тайский' },
        { id: 'other', name: 'Другой' },
      ],
    },
    {
      id: 'direction', label: 'Направление перевода', type: 'select', required: true,
      options: [{ id: 'to_ru', name: 'С языка на русский' }, { id: 'from_ru', name: 'С русского на язык' }],
    },
    {
      id: 'doc_kind', label: 'Что переводим', type: 'select', required: true,
      options: [
        { id: 'identity', name: 'Паспорт, удостоверение личности' },
        { id: 'diploma', name: 'Диплом, аттестат' },
        { id: 'civil', name: 'Свидетельство ЗАГС' },
        { id: 'certificate', name: 'Справка' },
        { id: 'contract', name: 'Договор' },
        { id: 'other', name: 'Другое' },
      ],
    },
    { id: 'docs', label: 'Документов, шт.', type: 'number', required: true, integer: true, min: 1, max: 100 },
    {
      id: 'pages', label: 'Страниц всего', type: 'number', required: true, integer: true, min: 1, max: 1000,
      hint: 'Личный документ (паспорт, свидетельство) до 1 800 знаков — 1 страница',
    },
    { id: 'comment', label: 'Что ещё важно знать', type: 'longtext', max: 2000 },
  ],

  services: [
    {
      id: 'notary_paper',
      name: 'Нотариальный перевод (бумага)',
      paper: 'Нотариально удостоверенный перевод',
      fields: [
        { id: 'urgent', label: 'Срочность', type: 'select', required: true, options: [{ id: 'no', name: '3–5 рабочих дней' }, { id: 'yes', name: 'Срочно: 1–2 дня, с наценкой' }] },
        ORIGINAL,
        DELIVERY_PAPER,
      ],
    },
    {
      id: 'notary_file',
      name: 'Нотариальный перевод (электронный файл)',
      paper: 'Нотариально удостоверенный перевод (электронный документ)',
      fields: [
        ORIGINAL,
        {
          id: 'delivery', label: 'Бумажный экземпляр', type: 'select', required: true,
          hint: 'Файл с подписью нотариуса придёт в личный кабинет за 2–4 рабочих дня',
          options: [
            { id: 'none', name: 'Не нужен, только файл' },
            { id: 'pickup', name: 'Заберу сам' },
            { id: 'courier', name: 'Курьером по Москве' },
          ],
        },
      ],
    },
    {
      id: 'plain',
      name: 'Перевод без нотариуса (с сертификатом платформы)',
      paper: 'Перевод с сертификатом платформы',
      fields: [
        { id: 'urgent', label: 'Срочность', type: 'select', required: true, options: [{ id: 'no', name: '1–2 дня' }, { id: 'yes', name: 'Срочно: день в день, с наценкой' }] },
        {
          id: 'delivery', label: 'Бумажный экземпляр', type: 'select', required: true,
          hint: 'PDF с подписью переводчика и сертификатом платформы — в личный кабинет',
          options: [{ id: 'none', name: 'Не нужен, только PDF' }, { id: 'courier', name: 'Курьером по Москве' }],
        },
      ],
    },
  ],

  // Исполнители (2а.3): только самозанятый, ИП, ООО или бюро; к нотариальным — с проверенным документом о знании языка заявки.
  executors: { tax_status: true, language_doc: { field: 'language', services: ['notary_paper', 'notary_file'] } },

  checks: [
    {
      id: 'names', title: 'Имена, фамилии и названия — как в документе и в загранпаспорте',
      ask: 'ФИО, географические названия и названия организаций переведены единообразно по всему тексту; написание имён латиницей — как в загранпаспорте, если он приложен',
    },
    {
      id: 'numbers', title: 'Даты, номера и суммы совпадают с оригиналом',
      ask: 'серии и номера документов, даты, суммы, номера записей актов переписаны без ошибок и в том же порядке',
    },
    {
      id: 'complete', title: 'Переведено всё: обороты, печати, штампы, подписи и отметки',
      ask: 'переведены или описаны в квадратных скобках все печати, штампы, подписи, рукописные пометки, апостиль и оборотная сторона',
    },
    {
      id: 'translator', title: 'Подпись переводчика: ФИО, документ о знании языка, дата',
      ask: 'в конце перевода — ФИО переводчика полностью, документ о знании языка, дата; для нотариального перевода — место для подписи перед нотариусом',
    },
  ],
};
