// Общие части операций: проверка ввода, журнал действий, что отдаётся наружу.
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
