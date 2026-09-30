import { api, say, formatPhone } from '/common.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');
let phone = '';

api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
// Уже вошли — сразу в кабинет.
api('GET', '/api/me').then(() => location.replace('/kabinet')).catch(() => {});

$('phone-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  say(msg, '');
  $('get-code').disabled = true;
  try {
    phone = $('phone').value;
    await api('POST', '/api/auth/code', { phone });
    $('code-hint').textContent = `Код отправлен на ${formatPhone(phone.replace(/\D/g, ''))}. Действует 5 минут.`;
    $('phone-form').classList.add('hidden');
    $('code-form').classList.remove('hidden');
    $('code').focus();
  } catch (err) {
    say(msg, err.message);
  } finally {
    $('get-code').disabled = false;
  }
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  say(msg, '');
  $('sign-in').disabled = true;
  try {
    await api('POST', '/api/auth/verify', { phone, code: $('code').value.trim() });
    location.replace('/kabinet');
  } catch (err) {
    say(msg, err.message);
    $('sign-in').disabled = false;
  }
});

$('change-phone').addEventListener('click', () => {
  $('code-form').classList.add('hidden');
  $('phone-form').classList.remove('hidden');
  $('code').value = '';
  say(msg, '');
});
