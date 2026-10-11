// Открытая страница проверки сертификата перевода (задача 2а.5). Код — после «#» в адресе из QR-кода (на сервер в адресе не
// уходит) или вводится с листа. Видно только номер, дату, языки, ФИО переводчика и отпечаток файла. Файл перевода
// сверяется на устройстве: страница считает SHA-256 и сравнивает с сертификатом — файл никуда не отправляется.
import { api, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const clean = (v) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
let cert = null;

api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});

async function check(raw) {
  const code = clean(raw);
  $('result').classList.add('hidden');
  cert = null;
  if (!/^[A-Z2-9]{12}$/.test(code)) return say($('code-msg'), 'Код — 12 букв и цифр, как на листе сертификата');
  say($('code-msg'), 'Проверяем…', 'ok');
  try {
    ({ certificate: cert } = await api('GET', `/api/certificates/${code}`));
  } catch (err) {
    return say($('code-msg'), err.status === 404 ? 'Сертификат с таким кодом не найден. Проверьте код на листе.' : err.message);
  }
  say($('code-msg'), '');
  const valid = cert.state === 'valid';
  $('state').textContent = valid ? 'Сертификат действует' : `Сертификат отозван ${dateRu(cert.revoked_at)}`;
  $('state').className = valid ? 'ok' : 'bad';
  $('result').dataset.state = cert.state;
  $('number').textContent = cert.number;
  $('issued').textContent = dateRu(cert.issued_at);
  $('languages').textContent = cert.languages;
  $('translator').textContent = cert.translator;
  $('sha').textContent = cert.sha256;
  $('file').value = '';
  say($('file-msg'), '');
  $('result').classList.remove('hidden');
}

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  history.replaceState(null, '', `${location.pathname}#${clean($('code').value)}`);
  check($('code').value);
});

$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f || !cert) return;
  if (!crypto?.subtle) return say($('file-msg'), 'Этот браузер не умеет считать отпечаток файла — сверьте отпечаток в другом браузере');
  say($('file-msg'), 'Сверяем…', 'ok');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  $('file-msg').dataset.match = String(hash === cert.sha256);
  if (hash === cert.sha256) say($('file-msg'), `Совпадает: «${f.name}» — тот самый файл перевода, к которому выдан сертификат.`, 'ok');
  else say($('file-msg'), `Не совпадает: «${f.name}» — не тот файл, к которому выдан сертификат (или его изменили после выдачи).`);
});

const fromHash = decodeURIComponent(location.hash.slice(1));
if (fromHash) { $('code').value = fromHash; check(fromHash); }
