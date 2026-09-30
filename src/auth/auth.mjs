// Вход по одноразовому коду. Образец — наследие (api.mjs:351-401) с исправлениями:
// код случайный и хранится только хэшем (Б-1), попытки не обнуляются новым кодом (Б-14),
// отключённый пользователь не входит и теряет сессии (Б-15), ошибки — кодами 4xx (Б-11).
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';

export const CODE_TTL_SEC = 300;
export const SESSION_TTL_SEC = 30 * 24 * 3600;
export const LIMITS = {
  resendAfterSec: 60,       // новый код не чаще раза в минуту
  codesPerHour: 5,          // не больше 5 кодов на номер в час
  attemptsPerCode: 5,       // 5 неверных вводов — код сгорает
  failuresPerHour: 10,      // 10 неверных вводов на номер в час — вход закрыт до конца часа
};

// +7XXXXXXXXXX из «8 (999) 000-00-01», «7999…», «+7 999 …». Иначе null.
export function normPhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  let d = digits;
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = d.slice(1);
  if (d.length !== 10 || d[0] !== '9') return null;
  return '+7' + d;
}

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sameHex(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export async function requestCode({ sql, cfg, providers }, phone) {
  const recent = await sql.one`
    select count(*)::int as n, max(created_at) as last from login_codes
    where phone = ${phone} and created_at > now() - interval '1 hour'`;
  if (recent.last && Date.now() - new Date(recent.last).getTime() < LIMITS.resendAfterSec * 1000) {
    throw new HttpError(429, 'resend_too_soon', 'Новый код можно запросить через минуту');
  }
  if (recent.n >= LIMITS.codesPerHour) throw new HttpError(429, 'too_many_codes', 'Слишком много кодов, попробуйте через час');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const row = await sql.one`
    insert into login_codes (phone, code_hash, expires_at)
    values (${phone}, ${hmac(cfg.appSecret, `${phone}:${code}`)}, now() + make_interval(secs => ${CODE_TTL_SEC}))
    returning id`;
  try {
    await providers.sms.sendCode({ phone, code });
  } catch {
    await sql`update login_codes set expires_at = now() where id = ${row.id}`;
    throw new HttpError(503, 'sms_unavailable', 'Не удалось отправить код, попробуйте позже');
  }
  return { ttlSec: CODE_TTL_SEC };
}

export async function verifyCode({ sql, cfg }, phone, code) {
  const failures = await sql.one`
    select coalesce(sum(attempts), 0)::int as n from login_codes
    where phone = ${phone} and created_at > now() - interval '1 hour'`;
  if (failures.n >= LIMITS.failuresPerHour) throw new HttpError(429, 'too_many_attempts', 'Слишком много неверных попыток, попробуйте через час');

  const row = await sql.one`
    select id, code_hash, attempts from login_codes
    where phone = ${phone} and used_at is null and expires_at > now()
    order by created_at desc limit 1`;
  if (!row) throw new HttpError(400, 'code_expired', 'Код устарел, запросите новый');
  if (row.attempts >= LIMITS.attemptsPerCode) throw new HttpError(429, 'too_many_attempts', 'Слишком много неверных попыток, запросите новый код');

  const ok = /^\d{6}$/.test(String(code)) && sameHex(row.code_hash, hmac(cfg.appSecret, `${phone}:${code}`));
  if (!ok) {
    await sql`update login_codes set attempts = attempts + 1 where id = ${row.id}`;
    throw new HttpError(400, 'wrong_code', 'Неверный код');
  }
  const used = await sql.one`update login_codes set used_at = now() where id = ${row.id} and used_at is null returning id`;
  if (!used) throw new HttpError(400, 'code_expired', 'Код устарел, запросите новый');

  return sql.tx(async (tx) => {
    let user = await tx.one`select * from users where phone = ${phone}`;
    if (!user) user = await tx.one`insert into users (phone) values (${phone}) returning *`;
    if (!user.is_active) throw new HttpError(403, 'blocked', 'Учётная запись отключена');
    const token = crypto.randomBytes(32).toString('base64url');
    await tx`insert into sessions (token_hash, user_id, expires_at)
             values (${sha256(token)}, ${user.id}, now() + make_interval(secs => ${SESSION_TTL_SEC}))`;
    await tx`insert into audit_log (actor_id, action, subject_type, subject_id) values (${user.id}, 'auth.login', 'user', ${user.id})`;
    return { user, token };
  });
}

// Пользователь по токену сессии; отключённый — как не вошедший.
export async function sessionUser(sql, token) {
  if (!token || token.length > 100) return null;
  const user = await sql.one`
    select u.id, u.phone, u.full_name, u.platform_role from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256(token)} and s.expires_at > now() and u.is_active`;
  if (!user) return null;
  user.orgs = await sql`select org_id, role from org_members where user_id = ${user.id}`;
  user.tokenHash = sha256(token);
  return user;
}

export async function endSession(sql, tokenHash) {
  await sql`delete from sessions where token_hash = ${tokenHash}`;
}
