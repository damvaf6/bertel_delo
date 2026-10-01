// Модули-профессии как данные. Новая профессия = три описания: перечень услуг, поля заявки, список ИИ-проверок
// (устав, раздел 1а). Ядро не знает ничего о конкретной профессии — только этот формат.
//
// Формат модуля:
//   { id, name, basis: ['contract' | 'court', …], fields: [поле…], services: [{ id, name, fields: [поле…] }…],
//     checks: [{ id, title, services?: [id услуги…] }…] }
// Поле: { id, label, type: 'text' | 'longtext' | 'number' | 'select', required?, max?, min?, integer?,
//         options?: [{ id, name }…] (для select), pattern?, hint?, upper? }
//   Общие поля модуля идут в заявке перед полями услуги; id не должны совпадать.
// Описание проверяется при запуске: ошибка в описании — сервер не стартует.
import { HttpError } from '../http/core.mjs';
import expertise from './expertise.mjs';

export const DEFAULT_MODULES = [expertise];

// Виды основания заявки. «С реквизитами» — номер, дата и файл обязательны для отправки.
export const BASIS_KINDS = {
  contract: { name: 'Договор (оформит платформа)', details: false },
  court: { name: 'Определение суда', details: true },
};

const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const FIELD_TYPES = ['text', 'longtext', 'number', 'select'];
const FIELD_KEYS = ['id', 'label', 'type', 'required', 'max', 'min', 'integer', 'options', 'pattern', 'hint', 'upper'];
const TEXT_MAX = { text: 300, longtext: 2000 };

function fail(where, what) {
  throw new Error(`Описание модуля: ${where}: ${what}`);
}

function onlyKeys(obj, keys, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where, 'ожидается объект');
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  if (extra.length) fail(where, `лишние ключи ${extra.join(', ')}`);
}

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 300;

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
  onlyKeys(m, ['id', 'name', 'basis', 'fields', 'services', 'checks'], 'модуль');
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
    onlyKeys(s, ['id', 'name', 'fields'], where);
    if (!nonEmpty(s.name)) fail(where, 'нет названия');
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
    onlyKeys(c, ['id', 'title', 'services'], where);
    if (!nonEmpty(c.title)) fail(where, 'нет описания');
    if (c.services !== undefined && (!Array.isArray(c.services) || c.services.length === 0 || c.services.some((id) => !serviceIds.includes(id)))) {
      fail(where, 'services — непустой список услуг этого модуля');
    }
  }
  return m;
}

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
      return { module: m, service: s, fields: [...(m.fields ?? []), ...(s.fields ?? [])] };
    },
    // Правила проверки результата для услуги (общие для модуля и только для этой услуги).
    checks(moduleId, serviceId) {
      const m = modulesList.find((x) => x.id === moduleId);
      if (!m?.services.some((x) => x.id === serviceId)) return [];
      return m.checks.filter((c) => !c.services || c.services.includes(serviceId)).map((c) => ({ id: c.id, title: c.title }));
    },
    catalog() {
      return modulesList.map((m) => ({
        id: m.id,
        name: m.name,
        basis: m.basis.map((id) => ({ id, name: BASIS_KINDS[id].name, details: BASIS_KINDS[id].details })),
        services: m.services.map((s) => ({ id: s.id, name: s.name, fields: [...(m.fields ?? []), ...(s.fields ?? [])] })),
        checks: m.checks.map((c) => ({ id: c.id, title: c.title, services: c.services ?? m.services.map((s) => s.id) })),
      }));
    },
  };
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
