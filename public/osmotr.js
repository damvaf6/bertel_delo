// Страница дистанционного осмотра для владельца объекта (задача 2.3). Без входа: секрет ссылки — после «#» в адресе
// (на сервер в адресе не уходит), к ядру — в заголовке x-inspect-token. Владелец снимает по шагам; к каждому фото страница
// прикладывает время съёмки и место (если владелец разрешил). Тексты — только через textContent.
// Та же страница — для выезда помощника по экспресс-заявке (задача 2.4): /osmotr?visit=номер, со входом в кабинет; помощник
// ещё видит, где объект (поля из описания модуля), и заполняет данные с объекта.
// Задача 2.20: если эксперт попросил переснять шаг — просьба видна у шага, новое фото этого шага её закрывает.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const visitId = new URLSearchParams(location.search).get('visit');
const token = visitId ? '' : decodeURIComponent(location.hash.slice(1));
const headers = visitId ? {} : { 'x-inspect-token': token };
const API = visitId
  ? { view: `/api/visits/${encodeURIComponent(visitId)}`, photos: `/api/visits/${encodeURIComponent(visitId)}/photos`, finish: `/api/visits/${encodeURIComponent(visitId)}/finish` }
  : { view: '/api/inspect', photos: '/api/inspect/photos', finish: '/api/inspect/finish' };
const MAX_SIDE = 2560;        // крупные снимки уменьшаются до 2560 точек по длинной стороне — быстрее по мобильной сети
const GEO_FRESH_MS = 2 * 60_000;
let info = null;
let lastPos = null;
let geoDenied = false;

api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
// Секрет из адреса больше не нужен в строке браузера (не попадёт в историю, если страницу покажут кому-то с экрана).
if (!visitId) history.replaceState(null, '', location.pathname);

const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function closed(text) {
  $('intro').classList.add('hidden');
  $('steps-box').classList.add('hidden');
  $('closed').classList.remove('hidden');
  $('closed-text').textContent = text;
}

async function load() {
  try {
    info = visitId ? visitInfo((await api('GET', API.view)).visit) : await api('GET', API.view, undefined, headers);
  } catch (err) {
    if (visitId) return closed(err.status === 401 ? 'Войдите в кабинет и откройте выезд в разделе «Специалист».' : err.status === 404 ? 'Выезд не найден.' : err.message);
    return closed(err.status === 404 ? 'Ссылка неверная или больше не действует. Попросите эксперта прислать новую.' : err.message);
  }
  if (!info.active) return closed(info.message);
  $('service').textContent = info.service || '';
  if (visitId) {
    $('expires').textContent = `Выезд назначен на ${dateRu(info.planned_at)}.`;
    renderVisit();
  } else $('expires').textContent = `Ссылка действует до ${dateRu(info.expires_at)}.`;
  if (info.steps.some((s) => s.retake)) $('expires').textContent += ' Эксперт просит переснять шаги, отмеченные ниже.';
  renderSteps();
}

// ——— Выезд помощника (2.4) ———

const visitInfo = (v) => ({ ...v, active: v.state === 'active' });

function renderVisit() {
  document.title = 'Выезд на объект · БЕРТЕЛ Дело';
  $('brand-sub').textContent = 'выезд на объект';
  $('page-title').textContent = 'Выезд на объект';
  $('intro-text').textContent = 'Сфотографируйте объект по шагам ниже и заполните данные с места. У каждого фото записываются '
    + 'время и место съёмки. Эксперт работает дистанционно — по Вашим фото и данным.';
  $('object').classList.remove('hidden');
  $('object').replaceChildren(...info.object.flatMap((f) => [el('dt', { text: f.label }), el('dd', { text: String(f.value) })]));
  $('data-box').classList.remove('hidden');
  $('done-hint').textContent = 'Когда все нужные фото сделаны и данные заполнены, нажмите «Готово» — всё уйдёт эксперту, выезд закроется.';
  $('data-fields').replaceChildren(...info.fields.map((f) => {
    const id = `d-${f.id}`;
    let input;
    if (f.type === 'select') {
      input = el('select', { id, 'data-field': f.id }, el('option', { value: '', text: '— выберите —' }), ...f.options.map((o) => el('option', { value: o.id, text: o.name })));
    } else if (f.type === 'longtext') input = el('textarea', { id, 'data-field': f.id, maxlength: String(f.max ?? 2000) });
    else input = el('input', { id, 'data-field': f.id, type: 'text', ...(f.type === 'number' ? { inputmode: f.integer ? 'numeric' : 'decimal' } : { maxlength: String(f.max ?? 300) }) });
    const v = info.data?.[f.id];
    input.value = v === undefined || v === null ? '' : String(v);
    return el('div', { class: 'field' }, el('label', { for: id, text: f.required ? `${f.label} *` : f.label }), input,
      ...(f.hint ? [el('p', { class: 'muted', text: f.hint })] : []));
  }));
}

async function saveData() {
  const data = {};
  for (const node of $('data-fields').querySelectorAll('[data-field]')) data[node.dataset.field] = node.value;
  info.data = (await api('PUT', `${API.view}/data`, { data })).visit.data;
}

$('data-save').addEventListener('click', async () => {
  $('data-save').disabled = true;
  try {
    await saveData();
    say($('data-msg'), 'Данные сохранены', 'ok');
  } catch (err) {
    if (err.status === 410) return closed(err.message);
    say($('data-msg'), err.message);
  } finally { $('data-save').disabled = false; }
});

// Шаги и их строки на странице: число фото, просьба переснять, состояние отправки.
const stepUi = {};

function renderSteps() {
  $('steps').replaceChildren(...info.steps.map((s) => {
    const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', id: `f-${s.id}`, 'aria-label': `Фото: ${s.title}` });
    const status = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const count = el('span', { class: 'badge' });
    const button = el('label', { class: 'btn secondary', for: `f-${s.id}` });
    const retake = s.retake ? el('p', { class: 'photo-meta warn', 'data-retake': '', text: `Эксперт просит переснять: ${s.retake}` }) : '';
    input.addEventListener('change', () => { const file = input.files[0]; input.value = ''; if (file) enqueue(s, file); });
    const li = el('li', { class: 'card', 'data-step': s.id },
      el('div', { class: 'doc' }, el('span', { class: 'title', text: s.title }), count),
      retake,
      s.hint ? el('p', { class: 'muted', text: s.hint }) : '',
      button, input, status);
    stepUi[s.id] = { li, status, count, button };
    paintStep(s);
    return li;
  }));
  paintProgress();
}

function paintStep(s) {
  const { count, button } = stepUi[s.id];
  count.textContent = s.retake ? 'переснять' : s.photos ? `Фото: ${s.photos}` : s.optional ? 'если есть' : 'нужно фото';
  count.className = `badge${s.photos && !s.retake ? ' ok' : ''}`;
  button.textContent = s.retake ? 'Переснять' : s.photos ? 'Ещё фото' : 'Сфотографировать';
}

// Шаг не снят: нет фото или эксперт просит переснять (2.68: пересъёмка тоже считается несделанной).
const notDone = (s) => !s.photos || Boolean(s.retake);

function paintProgress() {
  const need = info.steps.filter((s) => !s.optional);
  const done = need.filter((s) => !notDone(s)).length;
  $('progress').textContent = done === need.length
    ? `Все нужные шаги сняты (${need.length}). Можно нажать «Готово» внизу страницы.`
    : `Снято ${done} из ${need.length} нужных шагов.`;
  $('progress').className = `msg ${done === need.length ? 'ok' : ''}`;
}

// ——— Отправка фото с повтором при плохой связи (2.68) ———
// Каждый снимок сразу встаёт в очередь со своим номером, временем и местом съёмки. Нет связи — фото остаётся в очереди
// и уходит само, когда связь появится (или по кнопке «Повторить сейчас»); повтор с тем же номером не создаёт второе фото.
// Пока очередь не пуста, «Готово» ждёт, а закрыть страницу браузер не даст без вопроса.

const queue = [];
let sending = false;
let wake = null;
const RETRY_MS = [2000, 4000, 8000, 15000, 30000];
const UPLOAD_TIMEOUT_MS = 90_000;

function photoId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Снимок можно повторить: нет связи, сервер не ответил или временно занят.
const retryable = (err) => err.network || err.status === 408 || err.status === 429 || err.status >= 500;

async function enqueue(s, file) {
  const shotAt = new Date().toISOString();
  say(stepUi[s.id].status, 'Готовим фото…', 'ok');
  const [pos, blob] = await Promise.all([position(), prepare(file)]);
  if (blob.size > info.limits.file_bytes) return say(stepUi[s.id].status, 'Фото больше 3 МБ — снимите ещё раз или уменьшите размер');
  queue.push({ id: photoId(), s, blob: new Blob([blob], { type: blob.type || file.type || 'image/jpeg' }), shotAt, pos });
  paintQueue();
  pump();
}

function paintQueue() {
  const n = queue.length;
  $('pending').textContent = n ? `Ещё не отправлено фото: ${n}. Не закрывайте страницу — отправим, как только будет связь.` : '';
  $('pending').classList.toggle('hidden', !n);
  for (const s of info.steps) {
    const mine = queue.filter((q) => q.s === s).length;
    if (mine && !stepUi[s.id].status.dataset.wait) say(stepUi[s.id].status, mine > 1 ? `Отправляем… (фото в очереди: ${mine})` : 'Отправляем…', 'ok');
  }
}

function pause(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); window.removeEventListener('online', done); wake = null; resolve(); }
    window.addEventListener('online', done);
    wake = done;
  });
}

async function send(q) {
  const h = { ...headers, 'x-step': q.s.id, 'x-shot-at': q.shotAt, 'x-photo-id': q.id };
  if (q.pos) Object.assign(h, { 'x-lat': String(q.pos.coords.latitude), 'x-lon': String(q.pos.coords.longitude), 'x-accuracy': String(q.pos.coords.accuracy) });
  return api('POST', API.photos, q.blob, h, { timeoutMs: UPLOAD_TIMEOUT_MS });
}

async function pump() {
  if (sending) return;
  sending = true;
  let fails = 0;
  try {
    while (queue.length) {
      const q = queue[0];
      const { status } = stepUi[q.s.id];
      try {
        const r = await send(q);
        queue.shift();
        fails = 0;
        delete status.dataset.wait;
        q.s.photos = r.photos;
        if (q.s.retake) { q.s.retake = null; stepUi[q.s.id].li.querySelector('[data-retake]')?.remove(); }
        paintStep(q.s);
        paintProgress();
        say(status, r.geo ? 'Фото отправлено' : 'Фото отправлено без геометки', 'ok');
      } catch (err) {
        if (err.status === 410) { queue.length = 0; return closed(err.message); }
        if (!retryable(err)) {
          queue.shift();
          delete status.dataset.wait;
          say(status, err.message);
        } else {
          const ms = RETRY_MS[Math.min(fails, RETRY_MS.length - 1)];
          fails += 1;
          status.dataset.wait = '1';
          say(status, `Нет связи — фото не потеряно, отправим снова через ${Math.round(ms / 1000)} с.`, 'warn');
          $('retry').classList.remove('hidden');
          paintQueue();
          await pause(ms);
          delete status.dataset.wait;
        }
      }
      paintQueue();
    }
  } finally {
    sending = false;
    $('retry').classList.add('hidden');
    // Очередь ушла — просьба подождать с «Готово» больше не нужна.
    if (!queue.length && $('finish-msg').dataset.wait) { say($('finish-msg'), 'Все фото отправлены — можно нажать «Готово».', 'ok'); delete $('finish-msg').dataset.wait; }
    paintQueue();
  }
}

$('retry').addEventListener('click', () => { if (wake) wake(); });
window.addEventListener('beforeunload', (e) => { if (queue.length) e.preventDefault(); });

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
    if (k === 1 && file.type === 'image/jpeg' && file.size <= info.limits.file_bytes * 0.9) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (blob) return blob;
  } catch { /* остаётся исходный файл */ }
  return file;
}

$('start').addEventListener('click', () => {
  $('start').classList.add('hidden');
  $('steps-box').classList.remove('hidden');
  startGeo();
});

$('finish').addEventListener('click', async () => {
  if (queue.length) {
    $('finish-msg').dataset.wait = '1';
    return say($('finish-msg'), `Подождите — ещё не отправлено фото: ${queue.length}. «Готово» сработает, когда они уйдут.`);
  }
  say($('finish-msg'), '');
  const missing = info.steps.filter((s) => (!s.optional && !s.photos) || s.retake).map((s) => s.title);
  if (missing.length && !confirm(`Не снято: ${missing.join(', ')}. Всё равно завершить?`)) return;
  $('finish').disabled = true;
  try {
    if (visitId) {
      await saveData();
      const { visit } = await api('POST', API.finish, {});
      const n = visit.steps.reduce((a, s) => a + s.photos, 0);
      return closed(`Спасибо! Эксперт получил ${n} фото и данные с объекта. Страницу можно закрыть.`);
    }
    const r = await api('POST', API.finish, {}, headers);
    closed(`Спасибо! Эксперт получил ${r.photos} фото. Страницу можно закрыть.`);
  } catch (err) {
    if (err.status === 410) return closed(err.message);
    say($('finish-msg'), err.message);
  } finally { $('finish').disabled = false; }
});

load();
