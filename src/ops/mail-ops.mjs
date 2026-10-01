// Почта для заявок (задача 1.9): человек подключает свой адрес в профиле и подтверждает его кодом из письма.
// Письма-заявки принимаются только с подтверждённого адреса (src/mail/inbound.mjs). Один адрес — у одного человека.
// Можно выбрать, от чьего имени заявки по письмам: лично или от организации, где человек состоит.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { memberOf } from '../access/policy.mjs';
import { normEmail } from '../mail/inbound.mjs';
import { audit, uuidFrom } from './util.mjs';

export const MAIL_CODE = {
  ttlSec: 30 * 60,
  resendAfterSec: 60,
  maxAttempts: 10,      // неверных вводов за час — дальше новый код только через час
};

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
const codeHash = (cfg, userId, email, code) => hmac(cfg.appSecret, `mail:${userId}:${email}:${code}`);

async function addressView(sql, cfg, actor) {
  const a = await sql.one`select a.*, o.name as org_name from mail_addresses a left join organizations o on o.id = a.org_id
                          where a.user_id = ${actor.id}`;
  return {
    inbox: cfg.mail.inbox,
    address: a ? {
      email: a.email,
      confirmed: !!a.confirmed_at,
      org_id: a.org_id,
      // Ушёл из организации — заявки по письмам не принимаются, пока не выбрано заново.
      org_name: a.org_id && memberOf(actor, a.org_id) ? a.org_name : null,
      org_lost: !!a.org_id && !memberOf(actor, a.org_id),
    } : null,
  };
}

export function mailOps() {
  return [
    {
      id: 'mail.get', method: 'GET', path: '/api/me/mail', auth: 'user', access: 'self',
      async handler({ sql, cfg, actor }) { return addressView(sql, cfg, actor); },
    },
    {
      // Подключить адрес (или сменить): код подтверждения уходит письмом на этот адрес. Прежний адрес перестаёт работать.
      id: 'mail.code', method: 'POST', path: '/api/me/mail', auth: 'user', access: 'self',
      async handler({ sql, cfg, actor, providers, body }) {
        const email = normEmail(body?.email);
        if (!email || String(body?.email ?? '').includes('<')) throw new HttpError(400, 'bad_email', 'Введите адрес почты, например name@example.ru');
        if (email === cfg.mail.inbox) throw new HttpError(400, 'bad_email', 'Это адрес для заявок — укажите свой');
        const taken = await sql.one`select 1 from mail_addresses where email = ${email} and confirmed_at is not null and user_id <> ${actor.id}`;
        if (taken) throw new HttpError(409, 'email_taken', 'Этот адрес уже подключён к другой учётной записи');
        const cur = await sql.one`select * from mail_addresses where user_id = ${actor.id}`;
        const sentAgo = cur?.code_sent_at ? (Date.now() - new Date(cur.code_sent_at).getTime()) / 1000 : Infinity;
        if (sentAgo < MAIL_CODE.resendAfterSec) throw new HttpError(429, 'resend_too_soon', 'Новый код можно запросить через минуту');
        if (cur && cur.attempts >= MAIL_CODE.maxAttempts && sentAgo < 3600) throw new HttpError(429, 'too_many_attempts', 'Слишком много неверных попыток, попробуйте через час');
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const same = cur?.email === email && !!cur.confirmed_at;
        await sql.tx(async (tx) => {
          // Смена адреса: прежний перестаёт принимать заявки сразу; организация остаётся.
          await tx`insert into mail_addresses (user_id, email, code_hash, code_expires, code_sent_at, attempts)
                   values (${actor.id}, ${email}, ${codeHash(cfg, actor.id, email, code)}, now() + make_interval(secs => ${MAIL_CODE.ttlSec}), now(), 0)
                   on conflict (user_id) do update set email = excluded.email, code_hash = excluded.code_hash,
                     code_expires = excluded.code_expires, code_sent_at = excluded.code_sent_at,
                     attempts = case when mail_addresses.code_sent_at > now() - interval '1 hour' then mail_addresses.attempts else 0 end,
                     confirmed_at = case when ${same} then mail_addresses.confirmed_at else null end`;
          await audit(tx, actor, 'mail.code', 'user', actor.id);
        });
        try {
          await providers.mail.send({
            to: email, subject: 'Код подтверждения почты — БЕРТЕЛ Дело',
            text: `Код подтверждения: ${code}\nВведите его в кабинете, в разделе «Профиль». Код действует 30 минут.\n`
              + 'Если Вы не подключали эту почту к БЕРТЕЛ Дело — просто не отвечайте на письмо.',
          });
        } catch {
          await sql`update mail_addresses set code_expires = now() where user_id = ${actor.id}`;
          throw new HttpError(503, 'mail_unavailable', 'Не удалось отправить письмо, попробуйте позже');
        }
        return { sent: true, ...(await addressView(sql, cfg, actor)) };
      },
    },
    {
      id: 'mail.confirm', method: 'POST', path: '/api/me/mail/confirm', auth: 'user', access: 'self',
      async handler({ sql, cfg, actor, body }) {
        const cur = await sql.one`select * from mail_addresses where user_id = ${actor.id}`;
        if (!cur || !cur.code_hash) throw new HttpError(400, 'code_expired', 'Сначала запросите код');
        if (cur.attempts >= MAIL_CODE.maxAttempts) throw new HttpError(429, 'too_many_attempts', 'Слишком много неверных попыток, запросите новый код через час');
        if (new Date(cur.code_expires) <= new Date()) throw new HttpError(400, 'code_expired', 'Код устарел, запросите новый');
        const code = String(body?.code ?? '').trim();
        const expected = Buffer.from(cur.code_hash, 'hex');
        const got = Buffer.from(codeHash(cfg, actor.id, cur.email, code), 'hex');
        if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(expected, got)) {
          await sql`update mail_addresses set attempts = attempts + 1 where user_id = ${actor.id}`;
          throw new HttpError(400, 'wrong_code', 'Неверный код');
        }
        await sql.tx(async (tx) => {
          const taken = await tx.one`select 1 from mail_addresses where email = ${cur.email} and confirmed_at is not null and user_id <> ${actor.id}`;
          if (taken) throw new HttpError(409, 'email_taken', 'Этот адрес уже подключён к другой учётной записи');
          await tx`update mail_addresses set confirmed_at = now(), code_hash = null, code_expires = null, attempts = 0 where user_id = ${actor.id}`;
          await audit(tx, actor, 'mail.confirm', 'user', actor.id);
        });
        return addressView(sql, cfg, actor);
      },
    },
    {
      // От чьего имени заявки по письмам: лично (null) или от организации, где вошедший состоит.
      id: 'mail.org', method: 'PATCH', path: '/api/me/mail', auth: 'user', access: 'self',
      async handler({ sql, cfg, actor, body }) {
        const orgId = body?.org_id == null || body.org_id === '' ? null : uuidFrom(body.org_id, 'Организация не найдена');
        if (orgId !== null && !memberOf(actor, orgId)) throw new HttpError(404, 'not_found', 'Организация не найдена');
        const r = await sql.one`update mail_addresses set org_id = ${orgId} where user_id = ${actor.id} returning user_id`;
        if (!r) throw new HttpError(400, 'no_address', 'Сначала подключите адрес почты');
        await audit(sql, actor, 'mail.org', 'user', actor.id, { org: orgId });
        return addressView(sql, cfg, actor);
      },
    },
    {
      // Отключить адрес: письма с него больше не принимаются, письма по заявкам туда больше не уходят.
      id: 'mail.delete', method: 'DELETE', path: '/api/me/mail', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        await sql.tx(async (tx) => {
          await tx`delete from mail_addresses where user_id = ${actor.id}`;
          await audit(tx, actor, 'mail.delete', 'user', actor.id);
        });
      },
    },
  ];
}
