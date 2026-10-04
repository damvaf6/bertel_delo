// Профиль → «Почта для заявок» (1.9): подключить адрес кодом из письма, выбрать, от чьего имени заявки по письмам, отключить.
import { api, el, say, quoted } from '/common.js';
import { state } from '/shell.js';

const $ = (id) => document.getElementById(id);
let data = null;

export async function showMail() {
  say($('mail-msg'), '');
  $('mail-code').value = '';
  data = await api('GET', '/api/me/mail');
  render();
}

function render() {
  const a = data.address;
  $('mail-inbox').textContent = data.inbox;
  $('mail-email').value = a?.email ?? '';
  $('mail-status').textContent = !a ? 'Почта не подключена.'
    : a.confirmed ? `Подключена: ${a.email}. Письма с неё принимаются как заявки.` : `Ждём код подтверждения, отправленный на ${a.email}.`;
  $('mail-status').className = a?.confirmed ? 'msg ok' : 'muted';
  $('mail-send').textContent = a?.confirmed ? 'Сменить адрес' : 'Получить код на почту';
  $('mail-code-box').classList.toggle('hidden', !a || a.confirmed);
  const orgs = state.me.orgs;
  $('mail-org-box').classList.toggle('hidden', !a?.confirmed || (!orgs.length && !a.org_id));
  $('mail-org').replaceChildren(el('option', { value: '', text: 'Лично' }),
    ...orgs.map((o) => el('option', { value: o.org_id, text: `Организация ${quoted(o.name)}` })));
  $('mail-org').value = a?.org_lost ? '' : a?.org_id ?? '';
  if (a?.org_lost) say($('mail-msg'), 'Вы больше не состоите в организации, от имени которой принимались заявки. Выберите заново.');
  $('mail-delete').classList.toggle('hidden', !a);
}

async function act(button, fn, ok) {
  button.disabled = true;
  try {
    data = { ...data, ...(await fn()) };
    render();
    if (ok) say($('mail-msg'), ok, 'ok');
  } catch (err) { say($('mail-msg'), err.message); } finally { button.disabled = false; }
}

$('mail-send').addEventListener('click', () => {
  const email = $('mail-email').value.trim();
  if (!email) return say($('mail-msg'), 'Введите адрес почты');
  return act($('mail-send'), () => api('POST', '/api/me/mail', { email }), 'Код отправлен — проверьте почту');
});

$('mail-confirm').addEventListener('click', () => {
  const code = $('mail-code').value.trim();
  if (!/^\d{6}$/.test(code)) return say($('mail-msg'), 'Введите 6 цифр из письма');
  return act($('mail-confirm'), () => api('POST', '/api/me/mail/confirm', { code }), 'Почта подключена');
});

$('mail-org').addEventListener('change', () => act($('mail-org'),
  () => api('PATCH', '/api/me/mail', { org_id: $('mail-org').value || null }), 'Сохранено'));

$('mail-delete').addEventListener('click', () => act($('mail-delete'), async () => {
  await api('DELETE', '/api/me/mail');
  return { address: null };
}, 'Почта отключена — письма с неё больше не принимаются'));
