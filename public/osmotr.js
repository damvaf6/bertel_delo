// Страница дистанционного осмотра для владельца объекта (задача 2.3). Без входа: секрет ссылки — после «#» в адресе
// (на сервер в адресе не уходит), к ядру — в заголовке x-inspect-token. Владелец снимает по шагам; к каждому фото страница
// прикладывает время съёмки и место (если владелец разрешил). Тексты — только через textContent.
// Та же страница — для выезда помощника по экспресс-заявке (задача 2.4): /osmotr?visit=номер, со входом в кабинет; помощник
// ещё видит, где объект (поля из описания модуля), и заполняет данные с объекта.
// Задача 2.20: если эксперт попросил переснять шаг — просьба видна у шага, новое фото этого шага её закрывает.
// Задача 2.423: после «Готово» владелец видит акт осмотра (шаги, номера фото, время и место) и отмечает «С актом ознакомлен».
// Черновик осмотра (задача штаба: приложение с экрана «Домой»): неотправленные фото, данные с объекта и сами шаги хранятся
// на телефоне (drafts.js) — страницу можно закрыть или открыть без связи, ничего не пропадёт; отправлено — черновик удалён.
import { api, el, say } from '/common.js';
import { getDraft, putDraft, dropDraft } from '/drafts.js';
import '/pwa.js';

const $ = (id) => document.getElementById(id);
const visitId = new URLSearchParams(location.search).get('visit');
let token = visitId ? '' : decodeURIComponent(location.hash.slice(1));
const headers = {};
const LAST = 'inspect:last';            // ссылка владельца, открытая последней: страница без «#…» продолжает её
let draftKey = '';
let draft = { photos: [] };
const API = visitId
  ? { view: `/api/visits/${encodeURIComponent(visitId)}`, photos: `/api/visits/${encodeURIComponent(visitId)}/photos`, finish: `/api/visits/${encodeURIComponent(visitId)}/finish` }
  : { view: '/api/inspect', photos: '/api/inspect/photos', finish: '/api/inspect/finish' };
const MAX_SIDE = 2560;        // крупные снимки уменьшаются до 2560 точек по длинной стороне — быстрее по мобильной сети
const THUMB_SIDE = 320;       // картинка для дела (2.71): эксперт видит снимки сразу, не открывая каждый
const THUMB_MAX = 64 * 1024;
const GEO_FRESH_MS = 2 * 60_000;
let info = null;
let lastPos = null;
let geoDenied = false;

api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
// Секрет из адреса больше не нужен в строке браузера (не попадёт в историю, если страницу покажут кому-то с экрана).
if (!visitId) history.replaceState(null, '', location.pathname);

const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// keep — черновик не удалять (не вошёл в кабинет, нет связи): фото и данные ещё понадобятся.
function closed(text, { keep = false } = {}) {
  if (!keep && draftKey) { dropDraft(draftKey); if (!visitId) dropDraft(LAST); draftKey = ''; }
  $('intro').classList.add('hidden');
  $('steps-box').classList.add('hidden');
  $('closed').classList.remove('hidden');
  $('closed-text').textContent = text;
}

async function load() {
  if (!visitId && !token) token = (await getDraft(LAST)) || '';
  if (!visitId) headers['x-inspect-token'] = token;
  draftKey = visitId ? `visit:${visitId}` : token ? `inspect:${token}` : '';
  if (draftKey) {
    draft = (await getDraft(draftKey)) || { photos: [] };
    if (!visitId) putDraft(LAST, token);
  }
  let offline = false;
  try {
    info = visitId ? visitInfo((await api('GET', API.view)).visit) : await api('GET', API.view, undefined, headers);
  } catch (err) {
    // Нет связи, а шаги уже открывались на этом телефоне — продолжаем по сохранённому: фото уйдут, когда связь появится.
    if (err.network && draft.info) { info = draft.info; offline = true; }
    else if (visitId) return closed(err.status === 401 ? 'Войдите в кабинет и откройте выезд в разделе «Специалист».' : err.status === 404 ? 'Выезд не найден.' : err.message, { keep: err.status !== 404 });
    else return closed(err.status === 404 ? 'Ссылка неверная или больше не действует. Попросите эксперта прислать новую.' : err.message, { keep: err.status !== 404 });
  }
  if (!info.active) { closed(info.message); return showAct(info.act); }
  if (!offline) saveDraft({ info });
  $('service').textContent = info.service || '';
  // Почерковедческая (2.81): снимают документ и образцы подписи, а не объект на месте.
  if (info.subject === 'document') {
    document.title = 'Съёмка документа · БЕРТЕЛ Дело';
    $('brand-sub').textContent = 'съёмка документа';
    $('page-title').textContent = 'Съёмка документа';
    $('intro-text').textContent = 'Эксперт просит сфотографировать документ и образцы подписи по шагам ниже. Вход не нужен. '
      + 'У каждого фото записываются время и место съёмки. Фото не заменяют оригинал: его передают эксперту отдельно.';
  }
  // Товароведческая (2.82): снимают товар и недостаток, а не объект недвижимости.
  if (info.subject === 'goods') {
    document.title = 'Осмотр товара · БЕРТЕЛ Дело';
    $('brand-sub').textContent = 'осмотр товара';
    $('page-title').textContent = 'Осмотр товара';
    $('intro-text').textContent = 'Эксперт просит сфотографировать товар и недостаток по шагам ниже. Вход не нужен. '
      + 'У каждого фото записываются время и место съёмки. Не ремонтируйте и не разбирайте товар до осмотра экспертом.';
  }
  // Ущерб после ДТП (2.97): снимают повреждённую машину; до осмотра её не ремонтируют.
  if (info.subject === 'car') {
    document.title = 'Осмотр автомобиля · БЕРТЕЛ Дело';
    $('brand-sub').textContent = 'осмотр автомобиля';
    $('page-title').textContent = 'Осмотр автомобиля';
    $('intro-text').textContent = 'Эксперт просит сфотографировать автомобиль и каждое повреждение по шагам ниже. Вход не нужен. '
      + 'У каждого фото записываются время и место съёмки. Не ремонтируйте автомобиль до осмотра экспертом.';
  }
  if (visitId) {
    $('expires').textContent = `Выезд назначен на ${dateRu(info.planned_at)}.`;
    renderVisit();
  } else $('expires').textContent = `Ссылка действует до ${dateRu(info.expires_at)}.`;
  if (info.steps.some((s) => s.retake)) $('expires').textContent += ' Эксперт просит переснять шаги, отмеченные ниже.';
  renderSteps();
  restore(offline);
}

// ——— Черновик на телефоне ———

function saveDraft(patch) {
  if (!draftKey) return;
  Object.assign(draft, patch, { saved_at: new Date().toISOString() });
  putDraft(draftKey, draft);
}

// Очередь в черновике — без ссылок на шаги страницы (их не сохранить), только номер шага.
const saveQueue = () => saveDraft({
  photos: queue.map((q) => ({ id: q.id, step: q.s.id, blob: q.blob, thumbBytes: q.thumbBytes, shotAt: q.shotAt, pos: q.pos })),
});

// Снятое в прошлый раз, но не отправленное — снова в очередь; данные с объекта — в поля.
function restore(offline) {
  const byId = new Map(info.steps.map((s) => [s.id, s]));
  for (const p of draft.photos || []) {
    const s = byId.get(p.step);
    if (s && p.blob) queue.push({ ...p, s });
  }
  if (visitId && draft.data) {
    for (const node of $('data-fields').querySelectorAll('[data-field]')) {
      if (draft.data[node.dataset.field] !== undefined) node.value = draft.data[node.dataset.field];
    }
    say($('data-msg'), 'Данные с объекта ещё не отправлены — они сохранены на телефоне. Нажмите «Сохранить данные», когда будет связь.', 'warn');
  }
  if (offline) say($('progress'), 'Нет связи — показываем сохранённое на этом телефоне. Снимайте дальше: фото уйдут, когда связь появится.', 'warn');
  if (!queue.length && !offline && !(visitId && draft.data)) return;
  $('start').classList.add('hidden');
  $('steps-box').classList.remove('hidden');
  startGeo();
  if (queue.length) {
    say($('finish-msg'), `Фото с прошлого раза ещё не отправлены: ${queue.length}. Отправляем — страницу можно не закрывать.`, 'warn');
    $('finish-msg').dataset.wait = '1';
    paintQueue();
    pump();
  }
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

function fieldData() {
  const data = {};
  for (const node of $('data-fields').querySelectorAll('[data-field]')) data[node.dataset.field] = node.value;
  return data;
}

async function saveData() {
  info.data = (await api('PUT', `${API.view}/data`, { data: fieldData() })).visit.data;
  saveDraft({ data: null, info });
}

// Каждое изменение поля сразу ложится в черновик на телефоне — закрытая страница или пропавшая связь его не сотрут.
$('data-fields').addEventListener('input', () => saveDraft({ data: fieldData() }));
$('data-fields').addEventListener('change', () => saveDraft({ data: fieldData() }));

$('data-save').addEventListener('click', async () => {
  $('data-save').disabled = true;
  try {
    await saveData();
    say($('data-msg'), 'Данные сохранены', 'ok');
  } catch (err) {
    if (err.status === 410) return closed(err.message);
    if (err.network) { saveDraft({ data: fieldData() }); return say($('data-msg'), 'Нет связи — данные сохранены на телефоне. Нажмите «Сохранить данные», когда связь появится.', 'warn'); }
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
    const retake = s.retake ? el('p', { class: 'photo-meta warn', 'data-retake': '', text: `Эксперт просит ${s.shot_before ? 'переснять' : 'снять'}: ${s.retake}` }) : '';
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
  count.textContent = s.retake ? (s.photos || s.shot_before ? 'переснять' : 'нужно фото') : s.photos ? `Фото: ${s.photos}` : s.optional ? 'если есть' : 'нужно фото';
  count.className = `badge${s.photos && !s.retake ? ' ok' : ''}`;
  button.textContent = s.retake && (s.photos || s.shot_before) ? 'Переснять' : s.photos ? 'Ещё фото' : 'Сфотографировать';
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
  const [pos, { blob, thumb }] = await Promise.all([position(), prepare(file)]);
  if (blob.size > info.limits.file_bytes) return say(stepUi[s.id].status, 'Фото больше 3 МБ — снимите ещё раз или уменьшите размер');
  // Картинка для дела едет впереди снимка тем же запросом: при повторе по плохой связи они не разойдутся.
  const type = blob.type || file.type || 'image/jpeg';
  queue.push({ id: photoId(), s, blob: new Blob(thumb ? [thumb, blob] : [blob], { type }), thumbBytes: thumb ? thumb.size : 0, shotAt, pos });
  saveQueue();
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
  if (q.thumbBytes) h['x-thumb-bytes'] = String(q.thumbBytes);
  if (q.pos) Object.assign(h, { 'x-lat': String(q.pos.lat), 'x-lon': String(q.pos.lon), 'x-accuracy': String(q.pos.accuracy) });
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
        saveQueue();
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
          saveQueue();
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

// Место — простыми числами: так его можно сохранить в черновике вместе с фото.
const plain = (p) => (p ? { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy } : null);

function position() {
  if (lastPos && Date.now() - lastPos.timestamp < GEO_FRESH_MS) return Promise.resolve(plain(lastPos));
  if (geoDenied || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition((p) => resolve(plain(p)), () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: GEO_FRESH_MS }));
}

// Уменьшить снимок (JPEG) и сделать картинку для дела; не вышло (например, HEIC в этом браузере) — уходит исходный файл,
// если он не больше лимита, без картинки (эксперт откроет его кнопкой).
async function prepare(file) {
  try {
    const bmp = await createImageBitmap(file);
    const thumb = await shrink(bmp, THUMB_SIDE, 0.7).catch(() => null);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const ok = thumb && thumb.size <= THUMB_MAX ? thumb : null;
    if (k === 1 && file.type === 'image/jpeg' && file.size <= info.limits.file_bytes * 0.9) return { blob: file, thumb: ok };
    const blob = await shrink(bmp, MAX_SIDE, 0.85);
    if (blob) return { blob, thumb: ok };
  } catch { /* остаётся исходный файл */ }
  return { blob: file, thumb: null };
}

function shrink(bmp, side, quality) {
  const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
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
    closed(`Спасибо! Эксперт получил ${r.photos} фото.`);
    showAct((await api('GET', API.view, undefined, headers).catch(() => ({}))).act);
  } catch (err) {
    if (err.status === 410) return closed(err.message);
    say($('finish-msg'), err.message);
  } finally { $('finish').disabled = false; }
});

// Акт осмотра для владельца (2.423): нет акта (ссылка отозвана, прошло больше 30 дней) — блока нет.
function showAct(act) {
  if (!act) return;
  $('act-box').classList.remove('hidden');
  $('act-title').textContent = act.title;
  const facts = [['Услуга', act.service], ['Когда снимали (МСК)', act.period], ['Как проведён осмотр', act.ways.join('; ')],
    ['Фото', `${act.total}, с местом съёмки — ${act.with_geo}`]].filter(([, v]) => v);
  $('act-facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('act-rows').replaceChildren(...act.rows.map((r) => el('li', {},
    el('div', { class: 'title', text: r.no == null ? r.step : `Фото ${r.no} · ${r.step}` }),
    el('div', { class: 'muted', text: r.no == null ? r.missed : `снято ${r.time} · место: ${r.geo} · ${r.who}` }))));
  paintAck(act.acked_at);
}

function paintAck(at) {
  $('act-ack').classList.toggle('hidden', Boolean(at));
  $('act-hint').classList.toggle('hidden', Boolean(at));
  if (at) say($('act-msg'), `Вы отметили «С актом ознакомлен» ${dateRu(at)}. Страницу можно закрыть.`, 'ok');
}

$('act-ack').addEventListener('click', async () => {
  $('act-ack').disabled = true;
  try {
    paintAck((await api('POST', '/api/inspect/ack', {}, headers)).acked_at);
  } catch (err) {
    say($('act-msg'), err.message);
  } finally { $('act-ack').disabled = false; }
});

load();
