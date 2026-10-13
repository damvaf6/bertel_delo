// Карточка допуска исполнителя (задача штаба 3f817197-…-81b2): в разделе «Специалист» — своя карточка с QR и листом Word;
// в «Управлении» — выдать, продлить, отозвать с причиной. Пояснение к отзыву видит только платформа.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const dayRu = (d) => dateRu(`${String(d).slice(0, 10)}T12:00:00Z`);

function stateText(c) {
  if (c.state === 'valid') return 'Карточка действует';
  if (c.state === 'expired') return `Срок карточки истёк ${dayRu(c.valid_until)}`;
  return `Карточка отозвана ${dateRu(c.revoked_at)}: ${c.revoke_reason_name}`;
}
const checkItems = (c) => c.checks.map((x) => el('li', { class: x.ok ? 'ok' : 'muted', 'data-ok': String(x.ok), text: `${x.ok ? '✓' : '—'} ${x.name}` }));

// ——— Исполнитель ———
export async function loadMyCard() {
  say($('mycard-msg'), '');
  const { card } = await api('GET', '/api/specialist/me/card');
  $('mycard-empty').classList.toggle('hidden', !!card);
  $('mycard').classList.toggle('hidden', !card);
  if (!card) return;
  $('mycard-box').dataset.state = card.state;
  $('mycard-state').textContent = stateText(card);
  $('mycard-state').className = card.state === 'valid' ? 'ok' : 'bad';
  $('mycard-number').textContent = card.number;
  $('mycard-until').textContent = dayRu(card.valid_until);
  $('mycard-code').textContent = card.code;
  $('mycard-level').textContent = `Пройдено проверок: ${card.level} из ${card.of}`;
  $('mycard-checks').replaceChildren(...checkItems(card));
  $('mycard-share').classList.toggle('hidden', card.state !== 'valid');
  $('mycard-qr').src = card.qr;
  $('mycard-url').href = card.url;
  $('mycard-url').textContent = card.url;
}

$('mycard-sheet').addEventListener('click', () => location.assign('/api/specialist/me/card/sheet'));

// ——— Администратор ———
let userId = null;
let current = null;

const yearAhead = () => {
  const d = new Date(Date.now() + 3 * 3600_000);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};

function renderAdmin(view) {
  current = view.card;
  const c = view.card;
  const active = !!c && !c.revoked_at;
  $('sp-card').classList.toggle('hidden', !c);
  if (c) {
    $('sp-card-box').dataset.state = c.state;
    $('sp-card-state').textContent = `№ ${c.number} · ${stateText(c)}`;
    $('sp-card-state').className = c.state === 'valid' ? 'ok' : 'bad';
    $('sp-card-facts').textContent = [`действует до ${dayRu(c.valid_until)}`, `пройдено проверок: ${c.level} из ${c.of}`,
      c.revoke_note ? `пояснение: ${c.revoke_note}` : null].filter(Boolean).join(' · ');
    $('sp-card-checks').replaceChildren(...checkItems(c));
    $('sp-card-url').href = c.url;
    $('sp-card-url').textContent = active ? 'Открыть страницу проверки' : 'Страница проверки (показывает «отозвана»)';
  }
  $('sp-card-until').value = active ? String(c.valid_until).slice(0, 10) : yearAhead();
  $('sp-card-docs').checked = active ? !!c.docs_checked : false;
  $('sp-card-issue').classList.toggle('hidden', active);
  $('sp-card-issue').textContent = c ? 'Выдать новую карточку' : 'Выдать карточку';
  $('sp-card-save').classList.toggle('hidden', !active);
  $('sp-card-revoke-box').classList.toggle('hidden', !active);
  $('sp-card-reason').replaceChildren(el('option', { value: '', text: 'Выберите причину' }), ...view.reasons.map((r) => el('option', { value: r.id, text: r.name })));
  $('sp-card-note').value = '';
  $('sp-card-history').replaceChildren(...view.history.filter((h) => h.revoked_at).map((h) => el('li', {},
    el('div', { class: 'title', text: `№ ${h.number} — отозвана ${dateRu(h.revoked_at)}` }),
    el('div', { class: 'muted', text: [h.revoke_reason_name, h.revoke_note].filter(Boolean).join(': ') })))));
}

export async function loadAdminCard(id) {
  userId = id;
  $('sp-card-box').classList.toggle('hidden', !id);
  if (!id) return;
  renderAdmin(await api('GET', `/api/admin/specialists/${id}/card`));
}

async function act(method, path, body, done) {
  try {
    renderAdmin(await api(method, `/api/admin/specialists/${userId}/card${path}`, body));
    say($('sp-msg'), done, 'ok');
  } catch (err) { say($('sp-msg'), err.message); }
}

$('sp-card-issue').addEventListener('click', () => act('POST', '', { valid_until: $('sp-card-until').value, docs_checked: $('sp-card-docs').checked }, 'Карточка допуска выдана'));
$('sp-card-save').addEventListener('click', () => act('PUT', '', { valid_until: $('sp-card-until').value, docs_checked: $('sp-card-docs').checked }, 'Карточка сохранена'));
$('sp-card-revoke').addEventListener('click', () => {
  if (!$('sp-card-reason').value) return say($('sp-msg'), 'Выберите причину отзыва');
  if (!confirm(`Отозвать карточку № ${current?.number}? Страница проверки сразу покажет «отозвана», новые дела исполнителю перестанут предлагать.`)) return;
  act('POST', '/revoke', { reason: $('sp-card-reason').value, note: $('sp-card-note').value }, 'Карточка отозвана');
});
