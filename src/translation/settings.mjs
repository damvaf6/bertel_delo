// Цены и правила «Переводов» правит администратор в кабинете (задача 2а.9, задача штаба 3f617197). Каждое сохранение — строка
// module_settings (история: кто, когда, что изменилось); действует последняя. Расчёт синхронный, поэтому действующие значения
// держатся в памяти процесса (src/translation/prices.mjs) и перечитываются из базы не реже раза в REFRESH_MS — так видят
// правку и другие копии сервера. Свой процесс после сохранения видит новые значения сразу.
import { SETTING_FIELDS, DEFAULT_SETTINGS, TRANSLATION_PRICES, applySettings, currentSettings, settingsFrom } from './prices.mjs';

export const SETTINGS_MODULE = 'translation';
const REFRESH_MS = 15_000;
let loadedAt = 0;
let loading = null;

// Перечитать действующие значения, если давно не читали (вызывает реестр операций перед каждой операцией).
export function refreshTranslationSettings(sql, { force = false } = {}) {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  loading ??= (async () => {
    try {
      const row = await sql.one`select settings from module_settings where module = ${SETTINGS_MODULE} order by id desc limit 1`;
      applySettings(row?.settings ?? null);
      loadedAt = Date.now();
    } catch (e) {
      // Нет связи с базой или запись не прошла проверку — остаются прежние значения; повтор при следующей операции.
      console.error('настройки перевода:', e?.message || e);
    } finally { loading = null; }
  })();
  return loading;
}

// После сохранения (транзакция закрыта) — свой процесс сразу считает по новым значениям.
export function useSavedSettings(values) {
  applySettings(values);
  loadedAt = Date.now();
}

// Новое приложение (тесты, запуск сервера) — прочитать заново при первой операции.
export function resetTranslationSettings() {
  applySettings(null);
  loadedAt = 0;
}

const rub = (kop) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
export function settingText(f, v) {
  if (f.kind === 'rub') return rub(v);
  if (f.kind === 'bool') return v ? 'да' : 'нет';
  if (f.kind === 'factor') return `×${String(v).replace('.', ',')}`;
  return String(v);
}

// Что изменилось между двумя наборами: [{ key, title, from, to }] (текстом).
export function settingsDiff(prev, next) {
  return SETTING_FIELDS.filter((f) => prev[f.key] !== next[f.key])
    .map((f) => ({ key: f.key, title: f.title, from: settingText(f, prev[f.key]), to: settingText(f, next[f.key]) }));
}

// Для кабинета администратора: поля с текущими и стартовыми значениями, история последних изменений.
export async function settingsView(sql) {
  await refreshTranslationSettings(sql, { force: true });
  const values = currentSettings();
  const rows = await sql`select s.id, s.settings, s.changed_at, u.full_name, u.phone
    from module_settings s left join users u on u.id = s.changed_by
    where s.module = ${SETTINGS_MODULE} order by s.id desc limit 21`;
  const history = rows.slice(0, 20).map((r, i) => {
    const prev = rows[i + 1]?.settings ? { ...DEFAULT_SETTINGS, ...rows[i + 1].settings } : DEFAULT_SETTINGS;
    return { id: String(r.id), at: r.changed_at, by: r.full_name || r.phone || null, changes: settingsDiff(prev, { ...DEFAULT_SETTINGS, ...r.settings }) };
  });
  return {
    fields: SETTING_FIELDS.map((f) => ({ key: f.key, group: f.group, title: f.title, kind: f.kind, min: f.min ?? null, max: f.max ?? null, value: values[f.key], default: f.def })),
    commission_percent: TRANSLATION_PRICES.commission_percent,
    history,
  };
}

// Сохранить: значения поверх действующих; ничего не изменилось — новой строки нет. Возвращает список изменений.
export async function saveSettings(tx, actorId, body) {
  await tx`select pg_advisory_xact_lock(hashtext(${'module_settings:' + SETTINGS_MODULE}))`;
  const row = await tx.one`select settings from module_settings where module = ${SETTINGS_MODULE} order by id desc limit 1`;
  const prev = row ? { ...DEFAULT_SETTINGS, ...row.settings } : DEFAULT_SETTINGS;
  const next = settingsFrom(body, prev);
  const changes = settingsDiff(prev, next);
  if (changes.length) {
    await tx`insert into module_settings (module, settings, changed_by) values (${SETTINGS_MODULE}, ${JSON.stringify(next)}, ${actorId})`;
  }
  return { next, changes };
}
