// Страница дистанционного осмотра для владельца объекта (задача 2.3). Без входа: секрет ссылки — после «#» в адресе
// (на сервер в адресе не уходит), к ядру — в заголовке x-inspect-token. Владелец снимает по шагам; к каждому фото страница
// прикладывает время съёмки и место (если владелец разрешил). Тексты — только через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.hash.slice(1));
const headers = { 'x-inspect-token': token };
const MAX_SIDE = 2560;        // крупные снимки уменьшаются до 2560 точек по длинной стороне — быстрее по мобильной сети
const GEO_FRESH_MS = 2 * 60_000;
let info = null;
let lastPos = null;
let geoDenied = false;

api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
// Секрет из адреса больше не нужен в строке браузера (не попадёт в историю, если страницу покажут кому-то с экрана).
history.replaceState(null, '', location.pathname);

const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function closed(text) {
  $('intro').classList.add('hidden');
  $('steps-box').classList.add('hidden');
  $('closed').classList.remove('hidden');
  $('closed-text').textContent = text;
}

async function load() {
  try {
    info = await api('GET', '/api/inspect', undefined, headers);
  } catch (err) {
    return closed(err.status === 404 ? 'Ссылка неверная или больше не действует. Попросите эксперта прислать новую.' : err.message);
  }
  if (!info.active) return closed(info.message);
  $('service').textContent = info.service || '';
  $('expires').textContent = `Ссылка действует до ${dateRu(info.expires_at)}.`;
  renderSteps();
}

function renderSteps() {
  $('steps').replaceChildren(...info.steps.map((s) => {
    const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', id: `f-${s.id}`, 'aria-label': `Фото: ${s.title}` });
    const status = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const count = el('span', { class: `badge${s.photos ? ' ok' : ''}`, text: s.photos ? `Фото: ${s.photos}` : s.optional ? 'если есть' : 'нужно фото' });
    input.addEventListener('change', () => upload(s, input, status, count));
    return el('li', { class: 'card', 'data-step': s.id },
      el('div', { class: 'doc' }, el('span', { class: 'title', text: s.title }), count),
      s.hint ? el('p', { class: 'muted', text: s.hint }) : '',
      el('label', { class: 'btn secondary', for: `f-${s.id}`, text: s.photos ? 'Ещё фото' : 'Сфотографировать' }),
      input, status);
  }));
}

function startGeo() {
  if (!navigator.geolocation) { geoDenied = true; $('geo-state').textContent = 'Телефон не сообщает место — фото уйдут без геометки.'; return; }
  navigator.geolocation.watchPosition((p) => {
    lastPos = p;
    $('geo-state').textContent = `Место определено (точность около ${Math.round(p.coords.accuracy)} м).`;
  }, () => {
    geoDenied = true;
    $('geo-state').textContent = 'Место не определено — фото уйдут без геометки, эксперт это увидит. Разрешите доступ к '
      + 'местоположению в настройках браузера и обновите страницу, если можете.';
  }, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
}

function position() {
  if (lastPos && Date.now() - lastPos.timestamp < GEO_FRESH_MS) return Promise.resolve(lastPos);
  if (geoDenied || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: GEO_FRESH_MS }));
}

// Уменьшить снимок (JPEG); не вышло (например, HEIC в этом браузере) — уходит исходный файл, если он не больше лимита.
async function prepare(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.type === 'image/jpeg' && file.size <= info.limits.file_bytes) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (blob) return blob;
  } catch { /* остаётся исходный файл */ }
  return file;
}

async function upload(s, input, status, count) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  say(status, 'Отправляем…', 'ok');
  try {
    const [pos, blob] = await Promise.all([position(), prepare(file)]);
    if (blob.size > info.limits.file_bytes) throw new Error('Фото больше 5 МБ — снимите ещё раз или уменьшите размер');
    const h = { ...headers, 'x-step': s.id, 'x-shot-at': new Date().toISOString() };
    if (pos) Object.assign(h, { 'x-lat': String(pos.coords.latitude), 'x-lon': String(pos.coords.longitude), 'x-accuracy': String(pos.coords.accuracy) });
    const r = await api('POST', '/api/inspect/photos', new Blob([blob], { type: blob.type || file.type || 'image/jpeg' }), h);
    s.photos = r.photos;
    count.textContent = `Фото: ${r.photos}`;
    count.classList.add('ok');
    input.previousElementSibling.textContent = 'Ещё фото';
    say(status, r.geo ? 'Фото отправлено' : 'Фото отправлено без геометки', 'ok');
  } catch (err) {
    if (err.status === 410) return closed(err.message);
    say(status, err.message);
  }
}

$('start').addEventListener('click', () => {
  $('start').classList.add('hidden');
  $('steps-box').classList.remove('hidden');
  startGeo();
});

$('finish').addEventListener('click', async () => {
  const missing = info.steps.filter((s) => !s.optional && !s.photos).map((s) => s.title);
  if (missing.length && !confirm(`Нет фото: ${missing.join(', ')}. Всё равно завершить?`)) return;
  $('finish').disabled = true;
  try {
    const r = await api('POST', '/api/inspect/finish', {}, headers);
    closed(`Спасибо! Эксперт получил ${r.photos} фото. Страницу можно закрыть.`);
  } catch (err) {
    if (err.status === 410) return closed(err.message);
    say($('finish-msg'), err.message);
  } finally { $('finish').disabled = false; }
});

load();
