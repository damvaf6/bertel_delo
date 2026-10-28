// Модули-профессии как данные. Новая профессия = три описания: перечень услуг, поля заявки, список ИИ-проверок
// (устав, раздел 1а). Ядро не знает ничего о конкретной профессии — только этот формат.
//
// Формат модуля:
//   { id, name, basis: ['contract' | 'court', …], fields: [поле…], services: [{ id, name, fields: [поле…], paper?, labels? }…],
//       paper — как называется итоговый документ на титуле Word (2.29): «Отчёт об оценке», «Заключение эксперта»…;
//       labels — своя подпись общего поля модуля у этой услуги (2.79): { purpose: 'Для чего нужна экспертиза' };
//       subject: 'document' — по ссылке осмотра снимают не объект, а документ (почерковедческая, 2.81): страница владельца так и
//       называется — «Съёмка документа»; 'goods' — снимают товар (товароведческая, 2.82): «Осмотр товара»; 'car' — снимают
//       повреждённую машину (ущерб после ДТП, 2.97): «Осмотр автомобиля», до осмотра не ремонтировать
//     checks: [{ id, title, services?: [id услуги…], ask?, auto?: [имя правила…], when? }…],
//       ask — что именно проверить (подсказка модели ИИ, человеку не показывается); auto — автоматические правила по
//       всему тексту отчёта (src/ai/report-checks.mjs, AUTO_CHECKS): их находки показываются под этой проверкой;
//       when: { field: id поля-списка, in: [значение…] } — пункт только для заявок с таким значением поля (чек-лист банка:
//       отчёт для Сбербанка — пункты по требованиям банка, задача штаба 3f917197)
//     draft?: [{ id, title, services?: [id услуги…], ask?, dossier?, table? }…],  — разделы черновика заключения от ИИ (задача 2.2);
//       dossier: 'info' — сюда подставляются сведения из досье эксперта, 'copies' — перечень копий документов (2.14);
//       table: 'task' — таблица «задание» из полей заявки, 'approaches' — таблица «подход — стоимость — вес» (2.29);
//       'questions' — вопросы из поля заявки questions дословно, нумерованным списком, с тем, кто их поставил (2.79);
//       ask — что писать в разделе и что оставить эксперту в [квадратных скобках];
//       approach — раздел только для подхода 'comparative' | 'cost' | 'income': если исполнитель его не применяет (2.33),
//       раздела в черновике нет, а разделы с номером в начале названия («7. …») нумеруются заново подряд;
//       reuse: true — методический раздел (стандарты, допущения, выбор подходов, методика): эксперт может взять его текст
//       из своего прошлого дела той же услуги (2.65), данные прошлого заказчика и объекта программа вычищает;
//       sources: true — сюда программа вставляет перечень использованных документов дела (2.95, src/docs/sources.mjs)
//     approaches?: { services: [id услуги…] }  — исполнитель отмечает, какие подходы к оценке применяет (2.33)
//     inspection?: [{ id, title, hint?, services?: [id услуги…], optional? }…],  — шаги дистанционного осмотра (2.3)
//     request_docs?: [{ id, title, hint?, services?: [id услуги…], basis?: [вид основания…], when? }…],  — документы, которые
//       исполнитель может одной кнопкой запросить у заказчика (2.64): выписка ЕГРН, ПТС, чек…; заказчик загружает файл к
//       каждому; basis — только для заявок с таким основанием (определение суда — когда экспертизу назначил суд, 2.66);
//       when: { field: id поля-списка, in: [значение…] } — только для заявок с таким значением поля (задание банка — 2.299)
//     express?: { services: [id услуги…], show: [id поля заявки…], fields: [поле + services?…] } }  — экспресс-услуга (2.4):
//       для каких услуг, какие поля заявки видит помощник на объекте и какие данные он заполняет (нужны шаги осмотра)
//     signature?: { services?: [id услуги…] }  — результат подписывается УКЭП исполнителя до сдачи (2.5); без services — все услуги
//     executors?: { tax_status?: true, language_doc?: { field: id поля-списка модуля, services: [id услуги…] } }  — кого
//       допускать (2а.3): tax_status — только с указанным статусом (самозанятый, ИП, ООО/бюро), без него допуск не выдаётся и
//       в подбор не попадает; language_doc — к этим услугам только с проверенным документом о знании языка из поля field
//     certificate?: { services: [id услуги…], language: id поля-списка модуля, direction?: id поля-списка (to_ru | from_ru) }  —
//       сертификат платформы к файлу результата (2а.5): номер, QR, открытая страница проверки; язык — из поля language
//     steps?: [{ id, title?, services?, by: ['executor' | 'dispatcher'…], before?: 'review', field?, titles?, hint?, note?, file? }…]  —
//       шаги заказа (2а.6): передать оригинал, подписать у нотариуса, выдать бумагу; отмечает исполнитель или диспетчер, заказчик
//       видит. field + titles — шаг только при таком значении поля заявки, со своим названием ({ значение: название });
//       before: 'review' — без шага не сдать на проверку; note — подпись поля пометки; file: true — шаг отмечается своим файлом
//       результата (файл нотариуса), только с before: 'review'
//     proofread?: { new_orders, sample_percent, redo_days, refund_note? }  — вычитка и переделка (2а.7): к правилам проверки
//       добавляется «Вычитка» — обязательно, пока у исполнителя в модуле сдано меньше new_orders дел, иначе выборочно
//       (sample_percent из 100); заказчик после выдачи может попросить бесплатную переделку (срок — не раньше redo_days дней),
//       тогда вычитка обязательна; refund_note — правило возврата, его видит диспетчер при отмене после начала работ
//     remarks?: { reply_days }  — замечания к сданному отчёту (2.431): после «готово» заказчик пишет, что пришли замечания
//       банка или суда (текст и файл), дело снова у исполнителя; срок ответа — reply_days рабочих дней
//     offer?: { version: 'ГГГГ-ММ-ДД', draft: true?, doc: путь в docs/, points: [{ id, text, to: 'customer' | 'executor', services? }…] }  —
//       главные условия оферты (2а.8) в карточке заявки: заказчику — свои пункты, исполнителю и служебным — все; draft — черновик,
//       пока юрист не проверил (пометка «пока не действует»); полный текст — doc
//     analogs?: { services: [id услуги…], min, fields: [поле + services? + near?…] }  — раздел «Аналоги» в деле (2.32): признаки
//       аналога по виду объекта (цена, дата объявления и регион — у всех, в ядре: src/analogs/analogs.mjs); min — сколько
//       нужно подтверждённых; near: { field: id числового поля заявки, within?: разница, pct?: разница в % } — предупреждение;
//       adjustments?: [{ id, name, services?, covers?: ['date' | 'region' | id признака с near…] }…] — виды корректировок (2.74),
//       covers — какие предупреждения «нужна корректировка» снимает такая корректировка; «Другая» (other) — в ядре, у всех
//     repeat?: [{ services: [id услуги…], match: [id поля заявки…], sections: [id раздела черновика…] }…]  — повторная оценка
//       того же объекта (2.118): по полям match (кадастровый номер, адрес, VIN) программа узнаёт своё прошлое дело с тем же
//       объектом; из него эксперт берёт разделы sections (описание объекта — данные объекта не вычищаются, данные прошлого
//       заказчика — да), аналоги и перечень запрошенных документов
// Поле: { id, label, type: 'text' | 'longtext' | 'number' | 'select', required?, max?, min?, integer?,
//         options?: [{ id, name }…] (для select), pattern?, hint?, upper? }
//   Общие поля модуля идут в заявке перед полями услуги; id не должны совпадать.
// Описание проверяется при запуске: ошибка в описании — сервер не стартует.
import { HttpError } from '../http/core.mjs';
import { AUTO_CHECKS } from '../ai/report-checks.mjs';
import { moduleProofread } from './extras.mjs';
import expertise from './expertise.mjs';
import translation from './translation.mjs';

export const DEFAULT_MODULES = [expertise, translation];

// Виды основания заявки. «С реквизитами» — номер, дата и файл обязательны для отправки.
export const BASIS_KINDS = {
  contract: { name: 'Договор (оформит платформа)', details: false },
  court: { name: 'Определение суда', details: true },
};

export const DRAFT_TABLES = ['task', 'approaches', 'analogs', 'questions'];
// Подходы к оценке (2.33): общие для всех модулей, где исполнитель их выбирает.
export const APPROACHES = Object.freeze({ comparative: 'Сравнительный', cost: 'Затратный', income: 'Доходный' });
const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const FIELD_TYPES = ['text', 'longtext', 'number', 'select'];
const FIELD_KEYS = ['id', 'label', 'type', 'required', 'max', 'min', 'integer', 'options', 'pattern', 'hint', 'upper'];
const TEXT_MAX = { text: 300, longtext: 2000 };

// Правило «Вычитка» (2а.7): добавляется к правилам проверки модуля, если вычитка этого дела нужна (orders.proofread).
export const PROOFREAD_CHECK = Object.freeze({ id: 'proofread', title: 'Вычитка: текст прочитан целиком, ошибок нет' });
export const PROOFREAD_REASONS = Object.freeze({
  new: 'обязательная — у исполнителя ещё мало сданных дел',
  sample: 'выборочная',
  redo: 'обязательная — заказчик нашёл ошибку после выдачи',
});

function fail(where, what) {
  throw new Error(`Описание модуля: ${where}: ${what}`);
}

function onlyKeys(obj, keys, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where, 'ожидается объект');
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  if (extra.length) fail(where, `лишние ключи ${extra.join(', ')}`);
}

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 300;
// Подсказка модели (ask) длиннее названия, но тоже ограничена: она уходит в каждый запрос к модели.
const askText = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 600;

function checkIds(list, where) {
  if (!Array.isArray(list) || list.length === 0) fail(where, 'пустой список');
  const seen = new Set();
  for (const x of list) {
    if (!ID_RE.test(x?.id ?? '')) fail(where, `неверный id «${x?.id}»`);
    if (seen.has(x.id)) fail(where, `id «${x.id}» повторяется`);
    seen.add(x.id);
  }
}

function validateField(f, where) {
  onlyKeys(f, FIELD_KEYS, where);
  if (!nonEmpty(f.label)) fail(where, 'нет подписи');
  if (!FIELD_TYPES.includes(f.type)) fail(where, `неизвестный тип «${f.type}»`);
  if (f.required !== undefined && typeof f.required !== 'boolean') fail(where, 'required — да/нет');
  if (f.type === 'select') {
    checkIds(f.options, `${where}, варианты`);
    for (const o of f.options) { onlyKeys(o, ['id', 'name'], `${where}, вариант ${o.id}`); if (!nonEmpty(o.name)) fail(where, `вариант ${o.id} без названия`); }
    for (const k of ['max', 'min', 'integer', 'pattern', 'upper']) if (f[k] !== undefined) fail(where, `${k} не для выбора из списка`);
  } else if (f.options !== undefined) fail(where, 'варианты только для выбора из списка');
  if (f.type === 'number') {
    for (const k of ['pattern', 'upper']) if (f[k] !== undefined) fail(where, `${k} не для числа`);
    if (f.min !== undefined && !Number.isFinite(f.min)) fail(where, 'min — число');
    if (f.max !== undefined && !Number.isFinite(f.max)) fail(where, 'max — число');
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) fail(where, 'min больше max');
  }
  if (f.type === 'text' || f.type === 'longtext') {
    if (f.min !== undefined || f.integer !== undefined) fail(where, 'min и integer — только для числа');
    if (f.max !== undefined && !(Number.isInteger(f.max) && f.max >= 1 && f.max <= TEXT_MAX[f.type])) fail(where, `max — от 1 до ${TEXT_MAX[f.type]}`);
    if (f.pattern !== undefined) {
      try { new RegExp(f.pattern, 'u'); } catch { fail(where, 'неверный шаблон'); }
      if (!nonEmpty(f.hint)) fail(where, 'у шаблона нет подсказки для человека');
    }
  }
}

export function validateModule(m) {
  onlyKeys(m, ['id', 'name', 'basis', 'fields', 'services', 'checks', 'draft', 'inspection', 'express', 'signature', 'analogs', 'approaches', 'request_docs', 'repeat', 'executors', 'certificate', 'steps', 'proofread', 'remarks', 'offer'], 'модуль');
  if (!ID_RE.test(m.id ?? '')) fail('модуль', `неверный id «${m.id}»`);
  const at = `модуль ${m.id}`;
  if (!nonEmpty(m.name)) fail(at, 'нет названия');
  if (!Array.isArray(m.basis) || m.basis.length === 0 || m.basis.some((b) => !BASIS_KINDS[b]) || new Set(m.basis).size !== m.basis.length) {
    fail(at, `основания — непустой список из ${Object.keys(BASIS_KINDS).join(', ')}`);
  }
  const common = m.fields ?? [];
  if (common.length) checkIds(common, `${at}, общие поля`);
  common.forEach((f) => validateField(f, `${at}, поле ${f.id}`));
  checkIds(m.services, `${at}, услуги`);
  for (const s of m.services) {
    const where = `${at}, услуга ${s.id}`;
    onlyKeys(s, ['id', 'name', 'fields', 'paper', 'labels', 'subject'], where);
    if (s.subject !== undefined && !['document', 'goods', 'car'].includes(s.subject)) fail(where, "subject — 'document', 'goods' или 'car' (снимают документ, товар или машину, а не объект)");
    if (s.labels !== undefined) {
      if (!s.labels || typeof s.labels !== 'object' || Array.isArray(s.labels)) fail(where, 'labels — { id общего поля: подпись }');
      for (const [id, label] of Object.entries(s.labels)) {
        if (!common.some((c) => c.id === id)) fail(where, `labels: «${id}» — не общее поле модуля`);
        if (!(nonEmpty(label) && label.length <= 120)) fail(where, `labels: подпись поля ${id} — текст до 120 знаков`);
      }
    }
    if (!nonEmpty(s.name)) fail(where, 'нет названия');
    if (s.paper !== undefined && !(nonEmpty(s.paper) && s.paper.length <= 80)) fail(where, 'paper — название документа до 80 знаков');
    const own = s.fields ?? [];
    if (own.length) checkIds(own, `${where}, поля`);
    own.forEach((f) => validateField(f, `${where}, поле ${f.id}`));
    const clash = own.find((f) => common.some((c) => c.id === f.id));
    if (clash) fail(where, `поле ${clash.id} совпадает с общим полем модуля`);
  }
  checkIds(m.checks, `${at}, ИИ-проверки`);
  const serviceIds = m.services.map((s) => s.id);
  for (const c of m.checks) {
    const where = `${at}, проверка ${c.id}`;
    onlyKeys(c, ['id', 'title', 'services', 'ask', 'auto', 'when'], where);
    if (!nonEmpty(c.title)) fail(where, 'нет описания');
    if (c.ask !== undefined && !askText(c.ask)) fail(where, 'ask — непустой текст до 600 знаков');
    if (c.auto !== undefined && (!Array.isArray(c.auto) || c.auto.length === 0 || c.auto.some((a) => !Object.hasOwn(AUTO_CHECKS, a)))) {
      fail(where, `auto — непустой список из: ${Object.keys(AUTO_CHECKS).join(', ')}`);
    }
    if (c.services !== undefined && (!Array.isArray(c.services) || c.services.length === 0 || c.services.some((id) => !serviceIds.includes(id)))) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
    if (c.when !== undefined) {
      onlyKeys(c.when, ['field', 'in'], `${where}, when`);
      const users = m.services.filter((x) => !c.services || c.services.includes(x.id));
      const f = users.length ? serviceFields(m, users[0]).find((x) => x.id === c.when.field) : null;
      if (!f || f.type !== 'select' || users.some((x) => !serviceFields(m, x).some((y) => y.id === c.when.field))) {
        fail(where, 'when.field — поле-список, которое есть у каждой услуги проверки');
      }
      if (!Array.isArray(c.when.in) || c.when.in.length === 0 || c.when.in.some((v) => !f.options.some((o) => o.id === v))) {
        fail(where, 'when.in — непустой список значений этого поля');
      }
    }
  }
  // Разделы черновика заключения (2.2) — необязательно: без них черновик от ИИ для модуля не готовится.
  if (m.draft !== undefined) {
    checkIds(m.draft, `${at}, разделы черновика`);
    for (const d of m.draft) {
      const where = `${at}, раздел черновика ${d.id}`;
      onlyKeys(d, ['id', 'title', 'services', 'ask', 'dossier', 'table', 'approach', 'reuse', 'sources'], where);
      if (d.reuse !== undefined && d.reuse !== true) fail(where, 'reuse — только true (методический раздел)');
      if (d.sources !== undefined && d.sources !== true) fail(where, 'sources — только true (перечень использованных документов)');
      if (d.reuse && (d.table || d.dossier || d.sources)) fail(where, 'reuse — не у раздела с таблицей, досье или перечнем: их программа заполняет сама');
      if (d.approach !== undefined && !Object.hasOwn(APPROACHES, d.approach)) fail(where, `approach — одно из: ${Object.keys(APPROACHES).join(', ')}`);
      if (d.table !== undefined && !DRAFT_TABLES.includes(d.table)) fail(where, "table — 'task' (задание из полей заявки), 'approaches' (подходы и веса), 'analogs' (аналоги из дела) или 'questions' (вопросы из заявки)");
      if (d.table === 'questions') {
        const without = m.services.filter((x) => (!d.services || d.services.includes(x.id)) && !serviceFields(m, x).some((f) => f.id === 'questions'));
        if (without.length) fail(where, `table 'questions' — у услуги ${without[0].id} нет поля questions`);
      }
      if (!nonEmpty(d.title)) fail(where, 'нет описания');
      if (d.dossier !== undefined && !['info', 'copies'].includes(d.dossier)) fail(where, "dossier — 'info' (сведения об эксперте) или 'copies' (копии документов в приложениях)");
      if (d.ask !== undefined && !askText(d.ask)) fail(where, 'ask — непустой текст до 600 знаков');
      if (d.services !== undefined && (!Array.isArray(d.services) || d.services.length === 0 || d.services.some((id) => !serviceIds.includes(id)))) {
        fail(where, 'services — непустой список услуг этого модуля');
      }
    }
  }
  // Шаги дистанционного осмотра (2.3) — необязательно: без них ссылка владельцу для модуля не выдаётся.
  if (m.inspection !== undefined) {
    checkIds(m.inspection, `${at}, шаги осмотра`);
    for (const st of m.inspection) {
      const where = `${at}, шаг осмотра ${st.id}`;
      onlyKeys(st, ['id', 'title', 'hint', 'services', 'optional'], where);
      if (!nonEmpty(st.title) || st.title.length > 80) fail(where, 'нет названия или оно длиннее 80 знаков');
      if (st.hint !== undefined && !nonEmpty(st.hint)) fail(where, 'пустая подсказка');
      if (st.optional !== undefined && typeof st.optional !== 'boolean') fail(where, 'optional — да/нет');
      if (st.services !== undefined && (!Array.isArray(st.services) || st.services.length === 0 || st.services.some((id) => !serviceIds.includes(id)))) {
        fail(where, 'services — непустой список услуг этого модуля');
      }
    }
  }
  // Запрос документов у заказчика (2.64) — необязательно: без списка исполнитель просит документы своими словами.
  if (m.request_docs !== undefined) {
    checkIds(m.request_docs, `${at}, запрашиваемые документы`);
    for (const d of m.request_docs) {
      const where = `${at}, документ ${d.id}`;
      onlyKeys(d, ['id', 'title', 'hint', 'services', 'basis', 'when'], where);
      if (d.when !== undefined) {
        onlyKeys(d.when, ['field', 'in'], `${where}, when`);
        const users = d.services ? m.services.filter((x) => d.services.includes(x.id)) : m.services;
        const f = users.length ? serviceFields(m, users[0]).find((x) => x.id === d.when.field) : null;
        if (!f || f.type !== 'select' || users.some((x) => !serviceFields(m, x).some((y) => y.id === d.when.field))) {
          fail(where, 'when.field — поле-список, которое есть у каждой услуги документа');
        }
        if (!Array.isArray(d.when.in) || d.when.in.length === 0 || d.when.in.some((v) => !f.options.some((o) => o.id === v))) {
          fail(where, 'when.in — непустой список значений этого поля');
        }
      }
      if (d.basis !== undefined && (!Array.isArray(d.basis) || d.basis.length === 0 || d.basis.some((b) => !m.basis.includes(b)))) {
        fail(where, 'basis — непустой список оснований этого модуля');
      }
      if (!nonEmpty(d.title) || d.title.length > 120) fail(where, 'нет названия или оно длиннее 120 знаков');
      if (d.hint !== undefined && !nonEmpty(d.hint)) fail(where, 'пустая подсказка');
      if (d.services !== undefined && (!Array.isArray(d.services) || d.services.length === 0 || d.services.some((id) => !serviceIds.includes(id)))) {
        fail(where, 'services — непустой список услуг этого модуля');
      }
    }
  }
  // Повторная оценка того же объекта (2.118) — необязательно: без описания эксперт берёт из прошлого дела только
  // методические разделы (2.65).
  if (m.repeat !== undefined) {
    if (!Array.isArray(m.repeat) || m.repeat.length === 0) fail(`${at}, повторная оценка`, 'пустой список');
    const taken = new Set();
    for (const [i, r] of m.repeat.entries()) {
      const where = `${at}, повторная оценка ${i + 1}`;
      onlyKeys(r, ['services', 'match', 'sections'], where);
      if (!Array.isArray(r.services) || r.services.length === 0 || r.services.some((id) => !serviceIds.includes(id) || taken.has(id))) {
        fail(where, 'services — непустой список услуг этого модуля, каждая услуга — в одном описании');
      }
      r.services.forEach((id) => taken.add(id));
      for (const sid of r.services) {
        const own = serviceFields(m, m.services.find((s) => s.id === sid));
        if (!Array.isArray(r.match) || r.match.length === 0 || r.match.some((id) => !own.some((f) => f.id === id && f.type === 'text'))) {
          fail(where, `match — текстовые поля заявки услуги ${sid}`);
        }
        const draft = (m.draft ?? []).filter((d) => !d.services || d.services.includes(sid));
        if (!Array.isArray(r.sections) || r.sections.length === 0 || new Set(r.sections).size !== r.sections.length) fail(where, 'sections — непустой список разделов');
        for (const id of r.sections) {
          const d = draft.find((x) => x.id === id);
          if (!d) fail(where, `раздела ${id} нет в черновике услуги ${sid}`);
          if (d.reuse || d.table || d.dossier || d.sources) fail(where, `раздел ${id} — не методический, без таблицы, досье и перечня: их программа заполняет сама`);
        }
      }
    }
  }
  // Экспресс-услуга (2.4) — необязательно: помощник снимает по шагам осмотра, поэтому без них экспресса нет.
  if (m.express !== undefined) {
    const where = `${at}, экспресс`;
    onlyKeys(m.express, ['services', 'show', 'fields'], where);
    const ex = m.express;
    if (!Array.isArray(ex.services) || ex.services.length === 0 || ex.services.some((id) => !serviceIds.includes(id)) || new Set(ex.services).size !== ex.services.length) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
    const steps = (sid) => (m.inspection ?? []).filter((st) => !st.services || st.services.includes(sid));
    const noSteps = ex.services.find((sid) => steps(sid).length === 0);
    if (noSteps) fail(where, `у услуги ${noSteps} нет шагов осмотра`);
    const orderFields = new Set([...common, ...m.services.flatMap((s) => s.fields ?? [])].map((f) => f.id));
    if (!Array.isArray(ex.show) || ex.show.some((id) => !orderFields.has(id)) || new Set(ex.show).size !== ex.show.length) {
      fail(where, 'show — список полей заявки этого модуля');
    }
    checkIds(ex.fields, `${where}, данные с объекта`);
    for (const f of ex.fields) {
      const fw = `${where}, поле ${f.id}`;
      const { services, ...field } = f;
      validateField(field, fw);
      if (services !== undefined && (!Array.isArray(services) || services.length === 0 || services.some((id) => !ex.services.includes(id)))) {
        fail(fw, 'services — непустой список услуг экспресса');
      }
    }
  }
  // Подпись результата УКЭП (2.5) — необязательно: без неё результат сдаётся без подписи.
  if (m.signature !== undefined) {
    const where = `${at}, подпись`;
    onlyKeys(m.signature, ['services'], where);
    const sv = m.signature.services;
    if (sv !== undefined && (!Array.isArray(sv) || sv.length === 0 || sv.some((id) => !serviceIds.includes(id)) || new Set(sv).size !== sv.length)) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
  }
  // Кого допускать к услугам модуля (2а.3) — необязательно.
  if (m.executors !== undefined) {
    const where = `${at}, исполнители`;
    const ex = m.executors;
    onlyKeys(ex, ['tax_status', 'language_doc'], where);
    if (ex.tax_status !== undefined && ex.tax_status !== true) fail(where, 'tax_status — true или нет');
    if (ex.language_doc !== undefined) {
      onlyKeys(ex.language_doc, ['field', 'services'], `${where}, язык`);
      const f = (m.fields ?? []).find((x) => x.id === ex.language_doc.field);
      if (!f || f.type !== 'select' || !f.required) fail(where, 'language_doc.field — обязательное поле-список модуля');
      const sv = ex.language_doc.services;
      if (!Array.isArray(sv) || sv.length === 0 || sv.some((id) => !serviceIds.includes(id)) || new Set(sv).size !== sv.length) {
        fail(where, 'language_doc.services — непустой список услуг этого модуля');
      }
    }
  }
  // Сертификат платформы к результату (2а.5) — необязательно.
  if (m.certificate !== undefined) {
    const where = `${at}, сертификат`;
    const c = m.certificate;
    onlyKeys(c, ['services', 'language', 'direction'], where);
    const sv = c.services;
    if (!Array.isArray(sv) || sv.length === 0 || sv.some((id) => !serviceIds.includes(id)) || new Set(sv).size !== sv.length) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
    const lf = (m.fields ?? []).find((x) => x.id === c.language);
    if (!lf || lf.type !== 'select' || !lf.required) fail(where, 'language — обязательное поле-список модуля');
    if (c.direction !== undefined) {
      const df = (m.fields ?? []).find((x) => x.id === c.direction);
      const ids = df?.options?.map((o) => o.id) ?? [];
      if (!df || df.type !== 'select' || !df.required || ids.length !== 2 || !ids.includes('to_ru') || !ids.includes('from_ru')) {
        fail(where, 'direction — обязательное поле-список модуля с вариантами to_ru и from_ru');
      }
    }
  }
  // Шаги заказа (2а.6) — необязательно.
  if (m.steps !== undefined) {
    const where = `${at}, шаги заказа`;
    checkIds(m.steps, where);
    const allFields = [...(m.fields ?? []), ...(m.services ?? []).flatMap((x) => x.fields ?? [])];
    for (const st of m.steps) {
      const w = `${where}, ${st.id}`;
      onlyKeys(st, ['id', 'title', 'services', 'by', 'before', 'field', 'titles', 'hint', 'note', 'file'], w);
      const sv = st.services;
      if (sv !== undefined && (!Array.isArray(sv) || sv.length === 0 || sv.some((id) => !serviceIds.includes(id)) || new Set(sv).size !== sv.length)) {
        fail(w, 'services — непустой список услуг этого модуля');
      }
      if (!Array.isArray(st.by) || st.by.length === 0 || st.by.some((x) => !['executor', 'dispatcher'].includes(x)) || new Set(st.by).size !== st.by.length) {
        fail(w, 'by — executor и/или dispatcher');
      }
      if (st.before !== undefined && st.before !== 'review') fail(w, "before — только 'review'");
      if (st.file !== undefined && (st.file !== true || st.before !== 'review')) fail(w, "file: true — только с before: 'review'");
      if (st.field !== undefined) {
        const opts = new Set(allFields.filter((f) => f.id === st.field && f.type === 'select').flatMap((f) => f.options.map((o) => o.id)));
        if (!opts.size) fail(w, 'field — поле-список заявки');
        const t = st.titles;
        if (!t || typeof t !== 'object' || !Object.keys(t).length || Object.entries(t).some(([k, v]) => !opts.has(k) || typeof v !== 'string' || !v.trim())) {
          fail(w, 'titles — названия шага для вариантов поля field');
        }
      } else if (st.titles !== undefined || typeof st.title !== 'string' || !st.title.trim()) fail(w, 'title — название шага (titles — только с field)');
      for (const k of ['hint', 'note']) if (st[k] !== undefined && (typeof st[k] !== 'string' || !st[k].trim())) fail(w, `${k} — строка`);
    }
  }
  // Замечания к сданному отчёту (2.431) — необязательно; с переделкой переводов (proofread) вместе не бывает.
  if (m.remarks !== undefined) {
    const where = `${at}, замечания к сданному отчёту`;
    onlyKeys(m.remarks, ['reply_days'], where);
    if (!Number.isInteger(m.remarks.reply_days) || m.remarks.reply_days < 1 || m.remarks.reply_days > 30) fail(where, 'reply_days — целое от 1 до 30');
    if (m.proofread !== undefined) fail(where, 'вместе с proofread нельзя: после выдачи — либо переделка, либо замечания');
  }
  // Вычитка и переделка (2а.7) — необязательно.
  if (m.proofread !== undefined) {
    const where = `${at}, вычитка`;
    const p = m.proofread;
    onlyKeys(p, ['new_orders', 'sample_percent', 'redo_days', 'refund_note'], where);
    const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    if (!int(p.new_orders, 0, 100)) fail(where, 'new_orders — целое от 0 до 100');
    if (!int(p.sample_percent, 0, 100)) fail(where, 'sample_percent — целое от 0 до 100');
    if (!int(p.redo_days, 1, 30)) fail(where, 'redo_days — целое от 1 до 30');
    if (p.refund_note !== undefined && (typeof p.refund_note !== 'string' || !p.refund_note.trim())) fail(where, 'refund_note — строка');
    if ((m.checks ?? []).some((c) => c.id === PROOFREAD_CHECK.id)) fail(where, `id «${PROOFREAD_CHECK.id}» занят правилом проверки модуля`);
  }
  // Условия оферты (2а.8) — необязательно.
  if (m.offer !== undefined) {
    const where = `${at}, оферта`;
    const o = m.offer;
    onlyKeys(o, ['version', 'draft', 'doc', 'points'], where);
    if (typeof o.version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.version)) fail(where, 'version — дата ГГГГ-ММ-ДД');
    if (o.draft !== undefined && o.draft !== true) fail(where, 'draft — только true');
    if (typeof o.doc !== 'string' || !/^docs\/[\w./-]+\.md$/.test(o.doc)) fail(where, 'doc — путь к тексту в docs/…md');
    if (!Array.isArray(o.points) || o.points.length === 0) fail(where, 'points — непустой список');
    checkIds(o.points, where);
    for (const pt of o.points) {
      onlyKeys(pt, ['id', 'text', 'to', 'services'], `${where}, пункт ${pt.id}`);
      if (!nonEmpty(pt.text)) fail(`${where}, пункт ${pt.id}`, 'text — строка до 300 знаков');
      if (!['customer', 'executor'].includes(pt.to)) fail(`${where}, пункт ${pt.id}`, 'to — customer или executor');
      if (pt.services !== undefined && (!Array.isArray(pt.services) || pt.services.length === 0 || pt.services.some((id) => !serviceIds.includes(id)))) {
        fail(`${where}, пункт ${pt.id}`, 'services — непустой список услуг этого модуля');
      }
    }
    if (!o.points.some((pt) => pt.to === 'customer')) fail(where, 'нет пунктов для заказчика');
  }
  // Выбор подходов к оценке (2.33) — необязательно: без него черновик пишется со всеми разделами.
  if (m.approaches !== undefined) {
    const where = `${at}, подходы`;
    onlyKeys(m.approaches, ['services'], where);
    const sv = m.approaches.services;
    if (!Array.isArray(sv) || sv.length === 0 || sv.some((id) => !serviceIds.includes(id)) || new Set(sv).size !== sv.length) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
  }
  // Аналоги в деле (2.32) — необязательно: без них раздела «Аналоги» у услуги нет.
  if (m.analogs !== undefined) {
    const where = `${at}, аналоги`;
    const an = m.analogs;
    onlyKeys(an, ['services', 'min', 'fields', 'adjustments'], where);
    if (!Array.isArray(an.services) || an.services.length === 0 || an.services.some((id) => !serviceIds.includes(id)) || new Set(an.services).size !== an.services.length) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
    if (!Number.isInteger(an.min) || an.min < 1 || an.min > 10) fail(where, 'min — целое от 1 до 10');
    checkIds(an.fields, `${where}, признаки`);
    for (const f of an.fields) {
      const fw = `${where}, признак ${f.id}`;
      const { services, near, ...field } = f;
      if (ANALOG_CORE.includes(f.id)) fail(fw, `id «${f.id}» занят признаком ядра`);
      validateField(field, fw);
      if (field.type === 'longtext') fail(fw, 'признак — одной строкой (text), не longtext');
      if (services !== undefined && (!Array.isArray(services) || services.length === 0 || services.some((id) => !an.services.includes(id)))) {
        fail(fw, 'services — непустой список услуг раздела «Аналоги»');
      }
      if (near !== undefined) {
        onlyKeys(near, ['field', 'within', 'pct'], `${fw}, near`);
        if (field.type !== 'number') fail(fw, 'near — только у числового признака');
        if ((near.within === undefined) === (near.pct === undefined)) fail(fw, 'near — within или pct (одно из двух)');
        if (near.within !== undefined && !(Number.isFinite(near.within) && near.within >= 0)) fail(fw, 'near.within — число от 0');
        if (near.pct !== undefined && !(Number.isFinite(near.pct) && near.pct > 0 && near.pct <= 100)) fail(fw, 'near.pct — от 0 до 100');
        for (const sid of services ?? an.services) {
          const s = m.services.find((x) => x.id === sid);
          const of = [...common, ...(s.fields ?? [])].find((x) => x.id === near.field);
          if (!of || of.type !== 'number') fail(fw, `near.field — числовое поле заявки услуги ${sid}`);
        }
      }
    }
    if (an.adjustments !== undefined) {
      const aw = `${where}, корректировки`;
      if (!Array.isArray(an.adjustments) || an.adjustments.length === 0) fail(aw, 'adjustments — непустой список');
      checkIds(an.adjustments, aw);
      const nearIds = an.fields.filter((f) => f.near).map((f) => f.id);
      for (const k of an.adjustments) {
        const kw = `${aw}, ${k.id}`;
        onlyKeys(k, ['id', 'name', 'services', 'covers'], kw);
        if (k.id === 'other') fail(kw, 'id «other» занят корректировкой ядра «Другая»');
        if (typeof k.name !== 'string' || !k.name.trim() || k.name.length > 60) fail(kw, 'name — название до 60 знаков');
        if (k.services !== undefined && (!Array.isArray(k.services) || k.services.length === 0 || k.services.some((id) => !an.services.includes(id)))) {
          fail(kw, 'services — непустой список услуг раздела «Аналоги»');
        }
        if (k.covers !== undefined && (!Array.isArray(k.covers) || k.covers.some((c) => !['date', 'region', ...nearIds].includes(c)))) {
          fail(kw, "covers — 'date', 'region' или id признака с near");
        }
      }
    }
  }
  return m;
}

// Признаки аналога, которые есть у всех (ядро, src/analogs/analogs.mjs): модуль не может объявить их сам.
export const ANALOG_CORE = ['price_rub', 'listed_on', 'region'];

// Реестр модулей: проверяет описания и отвечает, какие поля у услуги и как её назвать.
export function createRegistry(modules = DEFAULT_MODULES) {
  const byId = new Map();
  for (const m of modules) {
    validateModule(m);
    if (byId.has(m.id)) throw new Error(`Описание модуля: модуль ${m.id} объявлен дважды`);
    byId.set(m.id, m);
  }
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const modulesList = deepFreeze(structuredClone([...byId.values()]));

  return {
    modules: modulesList,
    // Услуга с полным списком полей (общие + свои) или null.
    service(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      const s = m?.services.find((x) => x.id === serviceId);
      if (!s) return null;
      return { module: m, service: s, fields: serviceFields(m, s) };
    },
    // Правила проверки результата для услуги (общие для модуля и только для этой услуги). fields — поля заявки: пункты
    // с when (чек-лист банка) — только если поле заявки подходит; без полей заявки таких пунктов нет.
    checks(moduleId, serviceId, fields = null) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.services.some((x) => x.id === serviceId)) return [];
      return m.checks.filter((c) => (!c.services || c.services.includes(serviceId)) && (!c.when || c.when.in.includes(fields?.[c.when.field])))
        .map((c) => ({ id: c.id, title: c.title, ...(c.ask ? { ask: c.ask } : {}), ...(c.auto ? { auto: c.auto } : {}) }));
    },
    // Разделы черновика заключения для услуги (2.2); пустой список — черновик для услуги не готовится.
    // approaches — подходы, которые исполнитель применяет (2.33; null — не выбраны): разделов других подходов нет,
    // нумерация в названиях — подряд, без пропусков (иначе в отчёте «после раздела 13 сразу 15»).
    draftSections(moduleId, serviceId, approaches = null) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.draft || !m.services.some((x) => x.id === serviceId)) return [];
      const chosen = m.approaches?.services.includes(serviceId) && approaches?.length ? approaches : null;
      let n = 0;
      return m.draft.filter((d) => (!d.services || d.services.includes(serviceId)) && (!chosen || !d.approach || chosen.includes(d.approach)))
        .map((d) => {
          const title = chosen && /^\d+\.\s/.test(d.title) ? d.title.replace(/^\d+/, String(++n)) : d.title;
          return { id: d.id, title, ...(d.ask ? { ask: d.ask } : {}), ...(d.dossier ? { dossier: d.dossier } : {}), ...(d.table ? { table: d.table } : {}), ...(d.approach ? { approach: d.approach } : {}), ...(d.reuse ? { reuse: true } : {}), ...(d.sources ? { sources: true } : {}) };
        });
    },
    // Выбирает ли исполнитель подходы к оценке для услуги (2.33).
    approachesFor(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      return !!m?.approaches?.services.includes(serviceId);
    },
    // Шаги дистанционного осмотра для услуги (2.3); пустой список — ссылка владельцу для услуги не выдаётся.
    inspectionSteps(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.inspection || !m.services.some((x) => x.id === serviceId)) return [];
      return m.inspection.filter((st) => !st.services || st.services.includes(serviceId))
        .map((st) => ({ id: st.id, title: st.title, hint: st.hint ?? null, optional: !!st.optional }));
    },
    // Документы, которые исполнитель может запросить у заказчика по этой услуге (2.64); с when — только если поле заявки
    // подходит (2.299), без полей заявки таких пунктов нет.
    requestDocs(moduleId, serviceId, basisKind, fields) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.request_docs || !m.services.some((x) => x.id === serviceId)) return [];
      return m.request_docs.filter((d) => (!d.services || d.services.includes(serviceId)) && (!d.basis || d.basis.includes(basisKind))
        && (!d.when || d.when.in.includes(fields?.[d.when.field])))
        .map((d) => ({ id: d.id, title: d.title, hint: d.hint ?? null, ...(d.basis ? { basis: true } : {}) }));
    },
    // Повторная оценка того же объекта для услуги (2.118): поля, по которым узнаётся объект, и разделы описания объекта;
    // null — повторной оценки для услуги нет.
    repeat(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      const r = m?.repeat?.find((x) => x.services.includes(serviceId));
      if (!r) return null;
      const own = serviceFields(m, m.services.find((x) => x.id === serviceId));
      return { match: r.match.map((id) => { const f = own.find((x) => x.id === id); return { id, label: f.label }; }), sections: [...r.sections] };
    },
    // Экспресс-услуга для услуги (2.4): поля заявки, которые видит помощник, и данные, которые он заполняет; null — экспресса нет.
    express(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.express?.services.includes(serviceId)) return null;
      const s = m.services.find((x) => x.id === serviceId);
      const own = serviceFields(m, s);
      return {
        show: m.express.show.map((id) => own.find((f) => f.id === id)).filter(Boolean),
        fields: m.express.fields.filter((f) => !f.services || f.services.includes(serviceId)).map(({ services, ...f }) => f),
      };
    },
    // Кого допускать к услуге (2а.3): нужен ли статус исполнителя и по какому полю заявки нужен проверенный документ о
    // знании языка (null — не нужен).
    executorRules(moduleId, serviceId) {
      const ex = modulesList.find((x) => x.id === moduleId)?.executors;
      return {
        tax_status: !!ex?.tax_status,
        language_field: ex?.language_doc?.services.includes(serviceId) ? ex.language_doc.field : null,
      };
    },
    // Языки для документа о знании языка в досье (2а.3) — варианты полей language_doc всех модулей.
    languages() {
      const out = new Map();
      for (const m of modulesList) {
        const f = m.executors?.language_doc && m.fields.find((x) => x.id === m.executors.language_doc.field);
        for (const o of f?.options ?? []) if (!out.has(o.id)) out.set(o.id, o.name);
      }
      return [...out].map(([id, name]) => ({ id, name }));
    },
    // Сертификат платформы к результату услуги (2а.5): язык (название варианта) и направление из полей заявки; null — не выдаётся.
    certificate(moduleId, serviceId, fields = {}) {
      const m = modulesList.find((x) => x.id === moduleId);
      const c = m?.certificate;
      if (!c?.services.includes(serviceId)) return null;
      const lf = m.fields.find((x) => x.id === c.language);
      const lang = String(fields?.[c.language] ?? '');
      const dir = c.direction ? String(fields?.[c.direction] ?? '') : '';
      return {
        language: lang,
        language_name: lf.options.find((o) => o.id === lang)?.name ?? lang,
        direction: ['to_ru', 'from_ru'].includes(dir) ? dir : null,
      };
    },
    // Шаги заказа (2а.6) для услуги и значений полей заявки: те, что подходят, со своим названием.
    steps(moduleId, serviceId, fields = {}) {
      const m = modulesList.find((x) => x.id === moduleId);
      const out = [];
      for (const st of m?.steps ?? []) {
        if (st.services && !st.services.includes(serviceId)) continue;
        const value = st.field ? String(fields?.[st.field] ?? '') : null;
        if (st.field && !Object.hasOwn(st.titles, value)) continue;
        const title = st.field ? st.titles[value] : st.title;
        out.push({ id: st.id, title, by: st.by, before: st.before ?? null, hint: st.hint ?? null, note: st.note ?? null, file: !!st.file });
      }
      return out;
    },
    // Вычитка и переделка (2а.7): настройки модуля или null.
    proofread(moduleId) {
      const p = modulesList.find((x) => x.id === moduleId)?.proofread;
      // Числа — действующие настройки модуля, если администратор их правил (2а.9).
      return p ? { new_orders: p.new_orders, sample_percent: p.sample_percent, redo_days: p.redo_days, ...moduleProofread(moduleId), refund_note: p.refund_note ?? null } : null;
    },
    // Замечания к сданному отчёту (2.431): { reply_days } или null.
    remarks(moduleId) {
      const r = modulesList.find((x) => x.id === moduleId)?.remarks;
      return r ? { reply_days: r.reply_days } : null;
    },
    // Условия оферты (2а.8) для услуги: пункты заказчику (customer) и исполнителю (executor); null — у модуля оферты нет.
    offer(moduleId, serviceId) {
      const o = modulesList.find((x) => x.id === moduleId)?.offer;
      if (!o) return null;
      const own = o.points.filter((pt) => !pt.services || pt.services.includes(serviceId));
      const pick = (to) => own.filter((pt) => pt.to === to).map(({ id, text }) => ({ id, text }));
      return { version: o.version, draft: !!o.draft, doc: o.doc, customer: pick('customer'), executor: pick('executor') };
    },
    // Нужна ли подпись результата УКЭП исполнителя до сдачи на проверку (2.5).
    signatureRequired(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.signature || !m.services.some((x) => x.id === serviceId)) return false;
      return !m.signature.services || m.signature.services.includes(serviceId);
    },
    // Раздел «Аналоги» для услуги (2.32): сколько нужно и признаки этой услуги (без ядра); null — раздела нет.
    analogs(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.analogs?.services.includes(serviceId)) return null;
      const own = (x) => !x.services || x.services.includes(serviceId);
      return {
        min: m.analogs.min,
        fields: m.analogs.fields.filter(own).map(({ services, ...f }) => f),
        adjustments: (m.analogs.adjustments ?? []).filter(own).map(({ services, ...k }) => ({ covers: [], ...k })),
      };
    },
    catalog() {
      return modulesList.map((m) => ({
        id: m.id,
        name: m.name,
        basis: m.basis.map((id) => ({ id, name: BASIS_KINDS[id].name, details: BASIS_KINDS[id].details })),
        services: m.services.map((s) => ({ id: s.id, name: s.name, fields: serviceFields(m, s), express: !!m.express?.services.includes(s.id) })),
        checks: m.checks.map((c) => ({ id: c.id, title: c.title, services: c.services ?? m.services.map((s) => s.id), ...(c.when ? { when: c.when } : {}) })),
      }));
    },
  };
}

// Поля заявки услуги: общие поля модуля (с подписью этой услуги, если она своя — labels) и поля самой услуги.
function serviceFields(m, s) {
  const common = (m.fields ?? []).map((f) => (s.labels?.[f.id] ? { ...f, label: s.labels[f.id] } : f));
  return [...common, ...(s.fields ?? [])];
}

const bad = (message) => new HttpError(400, 'bad_input', message);

// Значения полей заявки: неизвестных полей нет, типы и ограничения соблюдены. Пустое значение — поле не заполнено.
// Обязательность проверяется при отправке заявки, а не при сохранении (черновик можно сохранять частями).
export function cleanValues(fields, input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('Поля заявки: неверный формат');
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const f = fields.find((x) => x.id === key);
    if (!f) throw bad('Поля заявки: лишнее поле');
    if (raw === null || raw === undefined || raw === '') continue;
    const name = `Поле «${f.label}»`;
    if (f.type === 'select') {
      if (!f.options.some((o) => o.id === raw)) throw bad(`${name}: выберите из списка`);
      out[key] = raw;
    } else if (f.type === 'number') {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*-?\d+([.,]\d+)?\s*$/.test(raw) ? Number(raw.replace(',', '.')) : NaN;
      if (!Number.isFinite(n)) throw bad(`${name}: нужно число`);
      if (f.integer && !Number.isInteger(n)) throw bad(`${name}: нужно целое число`);
      if (f.min !== undefined && n < f.min) throw bad(`${name}: не меньше ${f.min}`);
      if (f.max !== undefined && n > f.max) throw bad(`${name}: не больше ${f.max}`);
      out[key] = n;
    } else {
      if (typeof raw !== 'string') throw bad(`${name}: нужен текст`);
      let v = raw.trim();
      if (!v) continue;
      if (f.upper) v = v.toUpperCase();
      const max = f.max ?? TEXT_MAX[f.type];
      if (v.length > max) throw bad(`${name}: не длиннее ${max} символов`);
      if (f.pattern && !new RegExp(f.pattern, 'u').test(v)) throw bad(`${name}: ${f.hint}`);
      out[key] = v;
    }
  }
  return out;
}

// Каких обязательных полей не хватает — подписи полей.
export function missingRequired(fields, values) {
  return fields.filter((f) => f.required && (values?.[f.id] === undefined || values[f.id] === '')).map((f) => f.label);
}
