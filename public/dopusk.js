// Открытая страница проверки карточки допуска исполнителя (задача штаба 3f817197-…-81b2). Код — после «#» в адресе из
// QR-кода (на сервер в адресе не уходит) или вводится с карточки. Видно: действует ли карточка, номер, ФИО, срок, услуги и
// пройденные проверки; отозвана — дата и общая причина. Телефона, номеров документов и пояснений платформы здесь нет.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const dayRu = (d) => dateRu(`${d}T12:00:00Z`);
const clean = (v) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');

api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});

async function check(raw) {
  const code = clean(raw);
  $('result').classList.add('hidden');
  if (!/^[A-Z2-9]{12}$/.test(code)) return say($('code-msg'), 'Код — 12 букв и цифр, как на карточке');
  say($('code-msg'), 'Проверяем…', 'ok');
  let card;
  try {
    ({ card } = await api('GET', `/api/permit-cards/${code}`));
  } catch (err) {
    return say($('code-msg'), err.status === 404 ? 'Карточка с таким кодом не найдена. Проверьте код.' : err.message);
  }
  say($('code-msg'), '');
  const STATE = {
    valid: 'Карточка действует',
    expired: `Срок карточки истёк ${dayRu(card.valid_until)}`,
    revoked: card.revoked_at ? `Карточка отозвана ${dateRu(card.revoked_at)}: ${card.revoke_reason}` : '',
  };
  $('state').textContent = STATE[card.state];
  $('state').className = card.state === 'valid' ? 'ok' : 'bad';
  $('result').dataset.state = card.state;
  $('number').textContent = card.number;
  $('name').textContent = card.full_name;
  $('issued').textContent = dateRu(card.issued_at);
  $('until').textContent = dayRu(card.valid_until);
  $('services-box').classList.toggle('hidden', !card.services.length);
  $('services').replaceChildren(...card.services.map((s) => el('li', { text: s })));
  $('level').textContent = `Пройдено проверок: ${card.level} из ${card.of}`;
  $('checks').replaceChildren(...card.checks.map((c) => el('li', { class: c.ok ? 'ok' : 'muted', 'data-ok': String(c.ok), text: `${c.ok ? '✓' : '—'} ${c.name}` })));
  $('result').classList.remove('hidden');
}

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  history.replaceState(null, '', `${location.pathname}#${clean($('code').value)}`);
  check($('code').value);
});

const fromHash = decodeURIComponent(location.hash.slice(1));
if (fromHash) { $('code').value = fromHash; check(fromHash); }
