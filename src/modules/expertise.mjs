// Модуль «Дело: Экспертиза» — описание данными: перечень услуг, поля заявки, список ИИ-проверок.
// Виды на старте — по уставу (этап 2). Поля составлены по уставу; уточняются с ЦНЭР на этапе 2.
// Меняется только через разработку и автопроверки (решение Дамира 30.09.2026); формат — src/modules/index.mjs.

const CADASTRAL = { pattern: '^\\d{2}:\\d{2}:\\d{6,7}:\\d{1,}$', hint: 'Формат: 77:01:0001001:1234' };

export default {
  id: 'expertise',
  name: 'Экспертиза и оценка',
  basis: ['contract', 'court'],

  // Общие поля для всех услуг модуля.
  fields: [
    {
      id: 'purpose', label: 'Для чего нужна оценка', type: 'select', required: true,
      options: [
        { id: 'court', name: 'Для суда' },
        { id: 'inheritance', name: 'Наследство, нотариус' },
        { id: 'bank', name: 'Ипотека, залог, банк' },
        { id: 'deal', name: 'Купля-продажа' },
        { id: 'division', name: 'Раздел имущества' },
        { id: 'damage', name: 'Ущерб, страховой случай' },
        { id: 'other', name: 'Другое' },
      ],
    },
    {
      id: 'region', label: 'Где находится объект', type: 'select', required: true,
      options: [{ id: 'moscow', name: 'Москва' }, { id: 'mo', name: 'Московская область' }],
    },
    { id: 'comment', label: 'Что ещё важно знать', type: 'longtext', max: 2000 },
  ],

  services: [
    {
      id: 'realty',
      name: 'Оценка недвижимости',
      fields: [
        {
          id: 'object_type', label: 'Что оцениваем', type: 'select', required: true,
          options: [
            { id: 'flat', name: 'Квартира' },
            { id: 'room', name: 'Комната' },
            { id: 'share', name: 'Доля в квартире или доме' },
            { id: 'house', name: 'Жилой дом' },
            { id: 'commercial', name: 'Нежилое помещение' },
          ],
        },
        { id: 'address', label: 'Адрес объекта', type: 'text', required: true, max: 300 },
        { id: 'cadastral', label: 'Кадастровый номер', type: 'text', max: 40, ...CADASTRAL },
        { id: 'area', label: 'Площадь, кв. м', type: 'number', min: 1, max: 100000 },
      ],
    },
    {
      id: 'land',
      name: 'Оценка земельного участка',
      fields: [
        { id: 'address', label: 'Адрес или ориентир участка', type: 'text', required: true, max: 300 },
        { id: 'cadastral', label: 'Кадастровый номер', type: 'text', max: 40, ...CADASTRAL },
        { id: 'area', label: 'Площадь, кв. м', type: 'number', min: 1, max: 100000000 },
        {
          id: 'land_use', label: 'Назначение участка', type: 'select',
          options: [
            { id: 'izhs', name: 'Под жилой дом (ИЖС)' },
            { id: 'garden', name: 'Садоводство, дача' },
            { id: 'agri', name: 'Сельхозназначение' },
            { id: 'commercial', name: 'Под коммерцию или производство' },
            { id: 'other', name: 'Другое' },
          ],
        },
      ],
    },
    {
      id: 'vehicle',
      name: 'Оценка транспортного средства',
      fields: [
        {
          id: 'vehicle_type', label: 'Вид транспорта', type: 'select', required: true,
          options: [
            { id: 'car', name: 'Легковой автомобиль' },
            { id: 'truck', name: 'Грузовой автомобиль' },
            { id: 'moto', name: 'Мотоцикл' },
            { id: 'special', name: 'Спецтехника' },
            { id: 'other', name: 'Другое' },
          ],
        },
        { id: 'make_model', label: 'Марка и модель', type: 'text', required: true, max: 100 },
        { id: 'year', label: 'Год выпуска', type: 'number', integer: true, min: 1950, max: 2100 },
        { id: 'vin', label: 'VIN', type: 'text', max: 17, upper: true, pattern: '^[A-HJ-NPR-Z0-9]{17}$', hint: '17 латинских букв и цифр' },
      ],
    },
    {
      id: 'movable',
      name: 'Оценка движимого имущества',
      fields: [
        { id: 'items', label: 'Что оценить (перечень)', type: 'longtext', required: true, max: 2000 },
        { id: 'location', label: 'Где находится имущество', type: 'text', max: 300 },
      ],
    },
    {
      id: 'goods',
      name: 'Товароведческая экспертиза',
      fields: [
        { id: 'subject', label: 'Какой товар и что случилось', type: 'longtext', required: true, max: 2000 },
        { id: 'questions', label: 'Какие вопросы поставить эксперту', type: 'longtext', required: true, max: 2000 },
        { id: 'location', label: 'Где находится товар', type: 'text', max: 300 },
      ],
    },
  ],

  // ИИ-проверки заключения перед выдачей (устав, этап 2). Здесь — только перечень; проверка — помощь эксперту,
  // подпись и ответственность у человека. Выполнение — задачи 1.5 и 1.8.
  checks: [
    { id: 'requisites', title: 'Реквизиты: эксперт, организация, номер и дата заключения, подпись' },
    { id: 'object_match', title: 'Данные объекта в заключении совпадают с заявкой и документами' },
    { id: 'calculation', title: 'Расчёт: арифметика, итоговая величина, округление' },
    { id: 'analogs', title: 'Аналоги подобраны и описаны, корректировки обоснованы', services: ['realty', 'land', 'vehicle', 'movable'] },
    { id: 'error_margin', title: 'Допущения и погрешности указаны' },
    { id: 'questions_answered', title: 'Даны ответы на все вопросы заявки или суда' },
    { id: 'technical', title: 'Технические ошибки: опечатки, пропуски, нумерация, приложения' },
  ],

  // Разделы черновика заключения от ИИ (задача 2.2). Черновик — помощь эксперту: он правит текст, вписывает расчёт и
  // выводы и сам прикладывает итоговый файл; подпись и ответственность — у эксперта.
  draft: [
    { id: 'intro', title: 'Вводная часть: основание, вид оценки или экспертизы, цель, дата' },
    { id: 'object', title: 'Объект: что оценивается, адрес или местонахождение, характеристики по заявке и документам' },
    { id: 'inspection', title: 'Осмотр и фотоматериалы: перечень фото и что на них нужно описать' },
    { id: 'questions', title: 'Вопросы, на которые нужно ответить', services: ['goods'] },
    { id: 'method', title: 'Подходы и методы: какие применяются и почему' },
    { id: 'analogs', title: 'Аналоги и корректировки', services: ['realty', 'land', 'vehicle', 'movable'] },
    { id: 'calculation', title: 'Расчёт и итоговая величина' },
    { id: 'assumptions', title: 'Допущения, ограничения и погрешности' },
    { id: 'conclusion', title: 'Выводы' },
  ],

  // Дистанционный осмотр (задача 2.3): шаги фотофиксации для владельца объекта — по виду объекта (услуге). Владелец
  // снимает по ссылке без входа; у каждого фото — время и геометка. optional — шаг «если есть», его можно пропустить.
  inspection: [
    { id: 'facade', title: 'Дом снаружи', hint: 'Фасад целиком; чтобы был виден номер дома или табличка с адресом', services: ['realty'] },
    { id: 'entrance', title: 'Подъезд и лестничная площадка', hint: 'Вход в подъезд, площадка у квартиры', services: ['realty'] },
    { id: 'door', title: 'Входная дверь', hint: 'Дверь с номером квартиры или помещения', services: ['realty'] },
    { id: 'rooms', title: 'Каждая комната', hint: 'Общий вид из угла, затем с противоположной стороны', services: ['realty'] },
    { id: 'kitchen', title: 'Кухня', services: ['realty'] },
    { id: 'bathroom', title: 'Санузел и ванная', services: ['realty'] },
    { id: 'window_view', title: 'Вид из окна', services: ['realty'] },
    { id: 'meters', title: 'Счётчики и электрощит', services: ['realty'], optional: true },
    { id: 'land_overview', title: 'Участок целиком', hint: 'С нескольких точек, чтобы был виден весь участок', services: ['land'] },
    { id: 'land_borders', title: 'Границы и углы участка', hint: 'Забор, межевые знаки, если есть', services: ['land'] },
    { id: 'land_access', title: 'Подъезд к участку', hint: 'Дорога и въезд', services: ['land'] },
    { id: 'land_buildings', title: 'Постройки на участке', services: ['land'], optional: true },
    { id: 'land_utilities', title: 'Коммуникации', hint: 'Столб, газ, колодец, скважина', services: ['land'], optional: true },
    { id: 'surroundings', title: 'Окружение', hint: 'Улица, соседние дома или участки', services: ['realty', 'land'] },
    { id: 'car_front', title: 'Спереди', hint: 'Целиком, с номерным знаком', services: ['vehicle'] },
    { id: 'car_rear', title: 'Сзади', hint: 'Целиком, с номерным знаком', services: ['vehicle'] },
    { id: 'car_left', title: 'Слева', services: ['vehicle'] },
    { id: 'car_right', title: 'Справа', services: ['vehicle'] },
    { id: 'car_vin', title: 'VIN', hint: 'Номер на кузове или табличке, чтобы читались все знаки', services: ['vehicle'] },
    { id: 'car_odometer', title: 'Пробег', hint: 'Приборная панель с включённым зажиганием', services: ['vehicle'] },
    { id: 'car_interior', title: 'Салон', services: ['vehicle'] },
    { id: 'car_engine', title: 'Моторный отсек', services: ['vehicle'], optional: true },
    { id: 'item_overview', title: 'Каждый предмет целиком', services: ['movable'] },
    { id: 'item_marking', title: 'Маркировка и серийный номер', hint: 'Бирка, табличка, наклейка производителя', services: ['movable'] },
    { id: 'goods_overview', title: 'Товар целиком', hint: 'С нескольких сторон', services: ['goods'] },
    { id: 'goods_label', title: 'Этикетка и маркировка', hint: 'Название, артикул, размер, состав', services: ['goods'] },
    { id: 'goods_defect', title: 'Недостаток крупно', hint: '2–3 снимка с разных сторон, рядом — линейка или монета для масштаба', services: ['goods'] },
    { id: 'goods_package', title: 'Упаковка', services: ['goods'], optional: true },
    { id: 'defects', title: 'Повреждения и недостатки крупно', services: ['realty', 'vehicle', 'movable'], optional: true },
    { id: 'papers', title: 'Документы и чеки', hint: 'Паспорт изделия, чек, гарантийный талон', services: ['movable', 'goods'], optional: true },
  ],

  // Экспресс-услуга (задача 2.4): на объект выезжает помощник платформы, эксперт работает дистанционно. Помощник снимает
  // по шагам осмотра (inspection) и заполняет данные с объекта (fields). show — какие поля заявки помощник видит, чтобы
  // найти объект; имён, телефонов, цели оценки и комментария заказчика он не видит.
  express: {
    services: ['realty', 'land', 'vehicle', 'movable', 'goods'],
    show: ['object_type', 'address', 'cadastral', 'area', 'land_use', 'vehicle_type', 'make_model', 'year', 'vin', 'items', 'location', 'subject'],
    fields: [
      {
        id: 'condition', label: 'Общее состояние', type: 'select', required: true,
        options: [
          { id: 'good', name: 'Хорошее' },
          { id: 'normal', name: 'Обычное, без явных недостатков' },
          { id: 'needs_repair', name: 'Нужен ремонт' },
          { id: 'bad', name: 'Плохое, есть серьёзные повреждения' },
        ],
      },
      { id: 'area_measured', label: 'Площадь по замеру, кв. м', type: 'number', min: 1, max: 100000, services: ['realty'] },
      { id: 'floor', label: 'Этаж и этажность дома', type: 'text', max: 40, hint: 'Например: 5 из 9', services: ['realty'] },
      { id: 'renovation', label: 'Отделка', type: 'select', services: ['realty'],
        options: [{ id: 'none', name: 'Без отделки' }, { id: 'basic', name: 'Простая' }, { id: 'good', name: 'Хорошая' }, { id: 'premium', name: 'Дорогая' }] },
      { id: 'mileage', label: 'Пробег по прибору, км', type: 'number', integer: true, min: 0, max: 5000000, services: ['vehicle'] },
      { id: 'vin_match', label: 'VIN на кузове совпадает с документами', type: 'select', services: ['vehicle'],
        options: [{ id: 'yes', name: 'Да' }, { id: 'no', name: 'Нет' }, { id: 'no_docs', name: 'Документов нет на месте' }] },
      { id: 'buildings', label: 'Постройки на участке', type: 'text', max: 300, services: ['land'] },
      { id: 'match_order', label: 'Объект соответствует заявке', type: 'select', required: true,
        options: [{ id: 'yes', name: 'Да' }, { id: 'partly', name: 'Частично — см. замечания' }, { id: 'no', name: 'Нет — см. замечания' }] },
      { id: 'notes', label: 'Замечания помощника', type: 'longtext', max: 2000 },
    ],
  },

  // Заключение эксперта подписывается его УКЭП (задача 2.5): без подписи результат не сдаётся на проверку.
  signature: {},
};
