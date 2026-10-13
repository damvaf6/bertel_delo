// Карточка допуска исполнителя (задача штаба 3f817197-…-81b2): номер, срок действия, уровни проверки, QR со ссылкой на
// открытую страницу проверки (public/dopusk.html), отзыв с причиной. Кто выдаёт и отзывает — src/ops/permit-card-ops.mjs.
// Это внутренняя отметка платформы о пройденных проверках, не государственный документ. Ключи подписи платформа не хранит:
// уровень «подпись КЭП проверена» — отметка сотрудника после проверки подписи на Госуслугах (бесплатный сервис).
import { buildSimpleDoc } from '../docs/docx.mjs';
import { qrPng } from '../docs/qr.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { TAX_STATUSES } from './executors.mjs';
import { codeGroups } from '../translation/certificate.mjs';

export { newCode, codeFrom } from '../translation/certificate.mjs';

// Номер: Д-2026-000001 — по порядку выдачи.
export const permitCardNumber = (seq, at = new Date()) => `Д-${at.getFullYear()}-${String(seq).padStart(6, '0')}`;

// Ссылка проверки: код — после «#», в журналы серверов не попадает.
export const permitCardUrl = (origin, code) => `${origin}/dopusk.html#${code}`;

// Причины отзыва. public — что видно на открытой странице (без подробностей; пояснение администратора — только платформе).
export const REVOKE_REASONS = {
  request: { name: 'По заявлению исполнителя', public: 'по заявлению исполнителя' },
  documents: { name: 'Документ исполнителя истёк или утратил силу', public: 'документ исполнителя утратил силу' },
  rules: { name: 'Нарушение правил платформы', public: 'по решению платформы' },
  other: { name: 'Другое (пояснение обязательно)', public: 'по решению платформы' },
};

// Срок действия карточки: от завтра до пяти лет.
export const CARD_MAX_YEARS = 5;

// Проверки, из которых складывается уровень. Порядок — как на странице проверки.
export const CHECKS = [
  { id: 'phone', name: 'Телефон подтверждён кодом из СМС' },
  { id: 'status', name: 'Статус исполнителя проверен (самозанятый, ИП или организация)' },
  { id: 'docs', name: 'Документы об образовании и квалификации сверены платформой' },
  { id: 'kep', name: 'Подпись КЭП исполнителя проверена на Госуслугах' },
];

// Что проверено у исполнителя сейчас (не снимок на день выдачи: подпись могли проверить позже).
export async function cardChecks(sql, userId, card) {
  const row = await sql.one`
    select s.tax_status,
      exists (select 1 from dossier_items d where d.user_id = s.user_id and d.verified_at is not null and d.deleted_at is null) as docs_verified,
      exists (select 1 from document_signatures g where g.signer_id = s.user_id
              and (g.manual_check = 'ok' or (g.manual_check is null and g.checked_ok and not g.test))) as kep
    from specialists s where s.user_id = ${userId}`;
  const ok = {
    phone: true,
    status: !!row?.tax_status,
    docs: !!card?.docs_checked || !!row?.docs_verified,
    kep: !!row?.kep,
  };
  const checks = CHECKS.map((c) => ({
    id: c.id,
    name: c.id === 'status' && row?.tax_status ? `Статус исполнителя проверен: ${TAX_STATUSES[row.tax_status]?.name ?? row.tax_status}` : c.name,
    ok: ok[c.id],
  }));
  return { checks, level: checks.filter((c) => c.ok).length, of: checks.length };
}

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export function cardState(card, today = todayMsk()) {
  if (card.revoked_at) return 'revoked';
  return iso(card.valid_until) < today ? 'expired' : 'valid';
}

// Услуги, к которым исполнитель допущен сейчас (допуск без срока или срок не прошёл).
export async function cardServices(sql, userId, registry, today = todayMsk()) {
  const rows = await sql`select module, service from specialist_permits where user_id = ${userId}
                         and (valid_until is null or valid_until >= ${today}) order by module, service`;
  return rows.map((p) => {
    const def = registry.service(p.module, p.service);
    return def ? `${def.module.name}: ${def.service.name}` : `${p.module}: ${p.service}`;
  });
}

// Что видно на открытой странице проверки — только это: без телефона, номеров документов и пояснения к отзыву.
export async function publicCard(sql, card, registry) {
  const state = cardState(card);
  const { checks, level, of } = await cardChecks(sql, card.user_id, card);
  return {
    number: card.number,
    full_name: card.full_name,
    issued_at: card.issued_at,
    valid_until: iso(card.valid_until),
    state,
    services: state === 'valid' ? await cardServices(sql, card.user_id, registry) : [],
    checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
    level, of,
    ...(card.revoked_at ? { revoked_at: card.revoked_at, revoke_reason: REVOKE_REASONS[card.revoke_reason]?.public ?? 'по решению платформы' } : {}),
  };
}

// Карточка в кабинете (исполнителю и администратору): всё публичное плюс код, ссылка, QR; администратору — пояснение к отзыву.
export async function ownCard(sql, card, registry, origin, { staff = false } = {}) {
  const url = permitCardUrl(origin, card.code);
  return {
    ...(await publicCard(sql, card, registry)),
    code: codeGroups(card.code),
    url,
    qr: `data:image/png;base64,${qrPng(url, 6).toString('base64')}`,
    docs_checked: card.docs_checked,
    ...(card.revoked_at ? { revoke_reason_name: REVOKE_REASONS[card.revoke_reason]?.name ?? '' } : {}),
    ...(staff && card.revoked_at ? { revoke_note: card.revoke_note ?? '' } : {}),
  };
}

const dateRu = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });

// Лист «Карточка допуска» (Word): номер, исполнитель, срок, услуги, проверки, QR и код для страницы проверки.
export function permitCardSheet(view) {
  return buildSimpleDoc([
    { type: 'title', text: `Карточка допуска № ${view.number}` },
    { type: 'bold', text: 'Исполнитель прошёл проверки платформы БЕРТЕЛ Дело и допущен к услугам, перечисленным ниже.' },
    { type: 'table', rows: [
      ['Исполнитель', view.full_name],
      ['Дата выдачи', dateRu(view.issued_at)],
      ['Действует до', dateRu(`${view.valid_until}T12:00:00Z`)],
      ['Услуги', view.services.join('; ') || '—'],
      ['Уровень проверки', `пройдено проверок: ${view.level} из ${view.of}`],
      ...view.checks.map((c) => [c.ok ? 'Пройдено' : 'Не пройдено', c.name]),
    ] },
    { type: 'image', data: qrPng(view.url, 8), cm: 4.5 },
    { type: 'para', text: `Проверить карточку: наведите камеру телефона на QR-код или откройте ${view.url.split('#')[0]} и введите код ${view.code}.` },
    { type: 'para', text: 'На странице проверки видно, действует ли карточка сейчас: срок, услуги, пройденные проверки; если карточка отозвана — дата и общая причина.' },
    { type: 'note', text: 'Карточка допуска — внутренняя отметка платформы о пройденных проверках, не лицензия и не государственный документ. Подпись КЭП исполнителя можно проверить самостоятельно и бесплатно на Госуслугах.' },
  ]);
}
