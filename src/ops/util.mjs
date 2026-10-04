// Общие части операций: проверка ввода, журнал действий, что отдаётся наружу.
import crypto from 'node:crypto';
import { HttpError, UUID_RE } from '../http/core.mjs';
import { normPhone } from '../auth/auth.mjs';

export const publicUser = (u) => ({ id: u.id, phone: u.phone, full_name: u.full_name, platform_role: u.platform_role });

export function text(value, field, max) {
  const v = String(value ?? '').trim();
  if (!v || v.length > max) throw new HttpError(400, 'bad_input', `Поле «${field}»: от 1 до ${max} символов`);
  return v;
}

export function phoneFrom(value) {
  const phone = normPhone(value);
  if (!phone) throw new HttpError(400, 'bad_phone', 'Введите номер мобильного телефона России');
  return phone;
}

export function uuidFrom(value, notFoundMessage = 'Не найдено') {
  const v = String(value ?? '');
  if (!UUID_RE.test(v)) throw new HttpError(404, 'not_found', notFoundMessage);
  return v.toLowerCase();
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, 'bad_input', `Поле «${field}»: недопустимое значение`);
  return value;
}

export async function audit(sql, actor, action, subjectType, subjectId, details = {}) {
  await sql`insert into audit_log (actor_id, action, subject_type, subject_id, details)
            values (${actor?.id ?? null}, ${action}, ${subjectType}, ${String(subjectId)}, ${JSON.stringify(details)})`;
}

// Название в кавычках: «Бюро», но ООО «Бюро» — как записано, без второй пары кавычек (2.41).
export const quoted = (name) => (/[«"]/.test(String(name)) ? String(name) : `«${name}»`);

// Ответ контейнера облака — не больше 3,5 МБ (2.49): большой файл (Word черновика с фото) кладётся во временную папку
// хранилища (tmp/, срок жизни — сутки, правило бакета) и отдаётся временной ссылкой; маленький — сразу.
export const DIRECT_RESPONSE_MAX = 3 * 1024 * 1024;
export async function sendFile(res, providers, { buf, filename, mime }) {
  if (buf.length > DIRECT_RESPONSE_MAX) {
    const key = `tmp/${crypto.randomUUID()}`;
    await providers.storage.put(key, buf, mime);
    res.set('cache-control', 'no-store');
    return res.redirect(303, await providers.storage.link(key, { filename }));
  }
  res.set({
    'content-type': mime,
    'content-disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
  });
  return res.send(buf);
}
