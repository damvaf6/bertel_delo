// Карточка допуска исполнителя (задача штаба 3f817197-…-81b2). Выдаёт, продлевает и отзывает (с причиной) администратор
// платформы; исполнитель видит свою карточку с QR и скачивает лист Word; страницу проверки открывает любой по коду с листа
// или QR — без входа. Отозванная карточка снимает исполнителя с подбора, пока не выдана новая (candidatesFor в match-ops).
import { HttpError, rateLimiter } from '../http/core.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { notify } from '../notify/notify.mjs';
import { audit, sendFile, uuidFrom } from './util.mjs';
import { siteOrigin } from './certificate-ops.mjs';
import {
  CARD_MAX_YEARS, REVOKE_REASONS, codeFrom, newCode, ownCard, permitCardNumber, permitCardSheet, publicCard,
} from '../matching/permit-card.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 500;

function untilFrom(value) {
  const v = String(value ?? '');
  const d = new Date(`${v}T00:00:00Z`);
  if (!DATE_RE.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, 'bad_date', 'Поле «Действует до»: укажите дату');
  const today = todayMsk();
  if (v <= today || v > addDays(today, CARD_MAX_YEARS * 365)) throw new HttpError(400, 'bad_date', `Поле «Действует до»: не раньше завтра и не дальше ${CARD_MAX_YEARS} лет`);
  return v;
}

function docsFrom(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Документы сверены»: да или нет');
  return value;
}

// Последняя карточка исполнителя: действующая, а если её нет — последняя отозванная.
const lastCard = (sql, userId) => sql.one`select * from permit_cards where user_id = ${userId}
                                          order by (revoked_at is null) desc, issued_at desc, id desc limit 1`;

async function adminView(sql, userId, registry, origin) {
  const card = await lastCard(sql, userId);
  const history = await sql`select number, issued_at, valid_until, revoked_at, revoke_reason, revoke_note from permit_cards
                            where user_id = ${userId} order by issued_at desc, id desc limit 20`;
  return {
    card: card ? await ownCard(sql, card, registry, origin, { staff: true }) : null,
    history: history.map((h) => ({
      number: h.number, issued_at: h.issued_at, valid_until: h.valid_until, revoked_at: h.revoked_at,
      revoke_reason_name: h.revoke_reason ? REVOKE_REASONS[h.revoke_reason]?.name ?? '' : null, revoke_note: h.revoke_note ?? null,
    })),
    reasons: Object.entries(REVOKE_REASONS).map(([id, r]) => ({ id, name: r.name })),
  };
}

export function permitCardOps() {
  const checkLimit = rateLimiter({ windowMs: 10 * 60_000, max: 120 });
  return [
    {
      id: 'permit_cards.admin.get', method: 'GET', path: '/api/admin/specialists/:id/card', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, params, registry, cfg, req }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        if (!(await sql.one`select 1 from specialists where user_id = ${userId}`)) throw new HttpError(404, 'not_found', 'Специалист не найден');
        return adminView(sql, userId, registry, siteOrigin(cfg, req));
      },
    },
    {
      // Выдать карточку: нужен хотя бы один действующий допуск к услуге и ФИО в профиле (оно — на карточке и странице проверки).
      id: 'permit_cards.issue', method: 'POST', path: '/api/admin/specialists/:id/card', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry, cfg, req, res }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const until = untilFrom(body?.valid_until);
        const docs = docsFrom(body?.docs_checked) ?? false;
        await sql.tx(async (tx) => {
          const sp = await tx.one`select u.full_name from specialists s join users u on u.id = s.user_id where s.user_id = ${userId} for update of s`;
          if (!sp) throw new HttpError(404, 'not_found', 'Специалист не найден');
          const name = String(sp.full_name ?? '').trim();
          if (!name) throw new HttpError(409, 'no_name', 'У исполнителя в профиле не указаны фамилия, имя и отчество — они будут на карточке');
          const permit = await tx.one`select 1 from specialist_permits where user_id = ${userId} and (valid_until is null or valid_until >= ${todayMsk()}) limit 1`;
          if (!permit) throw new HttpError(409, 'no_permits', 'Сначала дайте допуск хотя бы к одной услуге — он будет на карточке');
          if (await tx.one`select 1 from permit_cards where user_id = ${userId} and revoked_at is null`) {
            throw new HttpError(409, 'card_exists', 'У исполнителя уже есть действующая карточка: продлите её или отзовите и выдайте новую');
          }
          const { n } = await tx.one`select nextval('permit_card_seq')::int as n`;
          const card = await tx.one`insert into permit_cards (number, code, user_id, full_name, valid_until, docs_checked, issued_by)
            values (${permitCardNumber(n)}, ${newCode()}, ${userId}, ${name.slice(0, 200)}, ${until}, ${docs}, ${actor.id}) returning *`;
          await audit(tx, actor, 'permit_card.issue', 'user', userId, { number: card.number, valid_until: until });
          await notify(tx, 'permit_card_issued', { users: [userId], actor });
        });
        res.status(201);
        return adminView(sql, userId, registry, siteOrigin(cfg, req));
      },
    },
    {
      // Продлить или сократить срок действующей карточки, отметить сверку документов.
      id: 'permit_cards.update', method: 'PUT', path: '/api/admin/specialists/:id/card', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry, cfg, req }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const until = body?.valid_until === undefined ? undefined : untilFrom(body.valid_until);
        const docs = docsFrom(body?.docs_checked);
        if (until === undefined && docs === undefined) throw new HttpError(400, 'bad_input', 'Нечего менять');
        await sql.tx(async (tx) => {
          const card = await tx.one`select * from permit_cards where user_id = ${userId} and revoked_at is null for update`;
          if (!card) throw new HttpError(404, 'not_found', 'Действующей карточки нет');
          await tx`update permit_cards set valid_until = ${until ?? card.valid_until}, docs_checked = ${docs ?? card.docs_checked} where id = ${card.id}`;
          await audit(tx, actor, 'permit_card.update', 'user', userId, { number: card.number, valid_until: until ?? null, docs_checked: docs ?? null });
        });
        return adminView(sql, userId, registry, siteOrigin(cfg, req));
      },
    },
    {
      // Отозвать с причиной. Страница проверки сразу показывает «отозвана» с общей причиной; исполнителю — уведомление.
      id: 'permit_cards.revoke', method: 'POST', path: '/api/admin/specialists/:id/card/revoke', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry, cfg, req }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const reason = String(body?.reason ?? '');
        if (!Object.hasOwn(REVOKE_REASONS, reason)) throw new HttpError(400, 'bad_input', 'Выберите причину отзыва');
        const note = String(body?.note ?? '').trim();
        if (note.length > NOTE_MAX) throw new HttpError(400, 'bad_input', `Пояснение — не длиннее ${NOTE_MAX} символов`);
        if (reason === 'other' && !note) throw new HttpError(400, 'bad_input', 'Напишите, почему отзываете карточку');
        await sql.tx(async (tx) => {
          const card = await tx.one`select * from permit_cards where user_id = ${userId} and revoked_at is null for update`;
          if (!card) throw new HttpError(404, 'not_found', 'Действующей карточки нет');
          await tx`update permit_cards set revoked_at = now(), revoked_by = ${actor.id}, revoke_reason = ${reason}, revoke_note = ${note || null}
                   where id = ${card.id}`;
          await audit(tx, actor, 'permit_card.revoke', 'user', userId, { number: card.number, reason });
          await notify(tx, 'permit_card_revoked', { users: [userId], actor });
        });
        return adminView(sql, userId, registry, siteOrigin(cfg, req));
      },
    },
    {
      // Своя карточка исполнителя: номер, срок, проверки, QR; отозвана — дата и причина (пояснение администратора не видно).
      id: 'specialist.me.card', method: 'GET', path: '/api/specialist/me/card', auth: 'user', access: 'self',
      async handler({ sql, actor, registry, cfg, req }) {
        if (!(await sql.one`select 1 from specialists where user_id = ${actor.id}`)) throw new HttpError(404, 'not_found', 'Вы не специалист');
        const card = await lastCard(sql, actor.id);
        return { card: card ? await ownCard(sql, card, registry, siteOrigin(cfg, req)) : null };
      },
    },
    {
      id: 'specialist.me.card.sheet', method: 'GET', path: '/api/specialist/me/card/sheet', auth: 'user', access: 'self',
      async handler({ sql, actor, registry, providers, cfg, req, res }) {
        const card = await sql.one`select * from permit_cards where user_id = ${actor.id} and revoked_at is null`;
        if (!card) throw new HttpError(404, 'not_found', 'Действующей карточки допуска нет');
        const view = await ownCard(sql, card, registry, siteOrigin(cfg, req));
        if (view.state !== 'valid') throw new HttpError(409, 'expired', 'Срок карточки истёк — попросите платформу продлить её');
        await audit(sql, actor, 'permit_card.sheet', 'user', actor.id, { number: card.number });
        return sendFile(res, providers, { buf: permitCardSheet(view), filename: `Карточка допуска ${card.number}.docx`, mime: DOCX_MIME });
      },
    },
    {
      id: 'permit_cards.check', method: 'GET', path: '/api/permit-cards/:code', auth: 'public',
      publicReason: 'Страница проверки карточки допуска исполнителя: открывает любой, у кого лист или QR-код (без входа)',
      rateLimit: (ip) => checkLimit(ip),
      async handler({ sql, params, registry }) {
        const code = codeFrom(params.code);
        const card = code && await sql.one`select * from permit_cards where code = ${code}`;
        if (!card) throw new HttpError(404, 'not_found', 'Карточка с таким кодом не найдена');
        return { card: await publicCard(sql, card, registry) };
      },
    },
  ];
}
