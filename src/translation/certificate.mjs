// Сертификат платформы к переводу без нотариуса (задача 2а.5, задача штаба 3f617197): номер, код для страницы проверки,
// QR со ссылкой, лист Word «Сертификат перевода». Кому и когда выдаётся — src/ops/certificate-ops.mjs.
import crypto from 'node:crypto';
import { buildSimpleDoc } from '../docs/docx.mjs';
import { qrPng } from '../docs/qr.mjs';

// Код проверки: 12 знаков без похожих (0/O, 1/I) — его можно набрать с листа руками. 32^12 — не перебрать.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z2-9]{12}$/;
export function newCode() {
  const b = crypto.randomBytes(12);
  return [...b].map((x) => ALPHABET[x % 32]).join('');
}
// Код с листа: «k7qf-2m9x-trb4» → «K7QF2M9XTRB4»; не похож на код — null.
export function codeFrom(value) {
  const v = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(v) ? v : null;
}
export const codeGroups = (code) => code.match(/.{4}/g).join('-');

// Номер: П-2026-000001 — по порядку выдачи.
export const certificateNumber = (seq, at = new Date()) => `П-${at.getFullYear()}-${String(seq).padStart(6, '0')}`;

// Ссылка проверки: код — после «#», в журналы серверов не попадает.
export const verifyUrl = (origin, code) => `${origin}/proverka.html#${code}`;

const dateRu = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });

// Языки словами: «с английского на русский» — по названию языка из списка заявки («Английский», «Иврит», «Хинди»).
function genitive(name) {
  const n = String(name).toLowerCase();
  if (n === 'другой') return 'другого языка';
  const m = n.match(/^(.*?)(ий|ый)(\s.*)?$/);
  if (m) return `${m[1]}ого${m[3] ?? ''}`;
  return /[бвгджзклмнпрстфхцчшщ]$/.test(n) ? `${n}а` : n;
}
const accusative = (name) => (String(name).toLowerCase() === 'другой' ? 'другой язык' : String(name).toLowerCase());
export function languagesText(c) {
  if (c.direction === 'to_ru') return `с ${genitive(c.language)} на русский`;
  if (c.direction === 'from_ru') return `с русского на ${accusative(c.language)}`;
  return `${accusative(c.language)} и русский`;
}

// Что видно на открытой странице проверки — только это: без заказчика, имени файла и текста.
export const publicCertificate = (c) => ({
  number: c.number,
  issued_at: c.issued_at,
  languages: languagesText(c),
  translator: c.translator_name,
  sha256: c.sha256,
  state: c.revoked_at ? 'revoked' : 'valid',
  ...(c.revoked_at ? { revoked_at: c.revoked_at } : {}),
});

// Сведения в деле (заказчику и переводчику): номер, код, ссылка, отозван ли.
export const caseCertificate = (c, origin) => ({
  number: c.number, code: c.code, url: verifyUrl(origin, c.code), issued_at: c.issued_at, revoked: !!c.revoked_at,
});

export const CERT_TEXT = 'Перевод выполнен через БЕРТЕЛ Дело, квалификация переводчика проверена.';

// Лист «Сертификат перевода» (Word): номер, кто перевёл, языки, отпечаток файла, QR и код для страницы проверки.
export function certificateSheet(c, { url, filename }) {
  return buildSimpleDoc([
    { type: 'title', text: `Сертификат перевода № ${c.number}` },
    { type: 'bold', text: CERT_TEXT },
    { type: 'table', rows: [
      ['Дата выдачи', dateRu(c.issued_at)],
      ['Перевод', languagesText(c)],
      ['Переводчик', c.translator_name],
      ...(c.qualification ? [['Документ о знании языка', c.qualification]] : []),
      ['Файл перевода', filename],
      ['Отпечаток файла (SHA-256)', c.sha256],
    ] },
    { type: 'image', data: qrPng(url, 8), cm: 4.5 },
    { type: 'para', text: `Проверить сертификат: наведите камеру телефона на QR-код или откройте ${url.split('#')[0]} и введите код ${codeGroups(c.code)}.` },
    { type: 'para', text: 'На странице проверки видны номер, дата, языки, ФИО переводчика и отпечаток файла. Там же можно выбрать файл перевода: страница сверит его отпечаток, файл никуда не отправляется.' },
    { type: 'note', text: 'Перевод без нотариального удостоверения. За качество перевода отвечает переводчик; гарантия платформы по сертификату — в пределах стоимости заказа.' },
  ]);
}
