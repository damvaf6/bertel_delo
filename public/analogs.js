// Аналоги в деле (2.32): эксперт вставляет ссылку и прикладывает скриншот — ИИ сам заполняет цену и признаки, эксперт
// проверяет и подтверждает. Диспетчер только смотрит; заказчику блок не показывается (сервер ему аналоги не отдаёт).
// Тексты — только через textContent; ссылки на объявления открываются в новой вкладке без доступа к нашей странице.
import { api, el, say } from '/common.js';
import { state } from '/shell.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 10 * 1024 * 1024;
const timeRu = (s) => `${new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} МСК`;
let ctx = null;   // { order, data }

export async function loadAnalogs(current) {
  const box = $('analogs-box');
  const staff = ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  const mine = !!current.executor?.is_me;
  ctx = null;
  if (!current.order.module || (!mine && !staff)) { box.classList.add('hidden'); return; }
  let data;
  try { data = await api('GET', `/api/orders/${current.order.id}/analogs`); } catch { box.classList.add('hidden'); return; }
  // Служебным — только когда аналоги уже есть; исполнителю — пока дело в работе или аналоги есть.
  if (!data.can_edit && !data.analogs.length) { box.classList.add('hidden'); return; }
  ctx = { order: current.order };
  say($('analogs-msg'), '');
  render(data);
  box.classList.remove('hidden');
}

function render(data) {
  ctx.data = data;
  $('analogs-state').textContent = `Подтверждено аналогов: ${data.confirmed} из ${data.min} нужных. `
    + (data.can_edit ? 'В Word они попадут таблицей, скриншоты — в приложение с датой получения и ссылкой.' : 'Аналоги меняет исполнитель.');
  $('analogs-hints').replaceChildren(...data.hints.map((h) => el('li', { text: h })));
  $('analogs-criteria').textContent = data.search.criteria;
  $('analogs-links').replaceChildren(...data.search.links.map((l) => el('a', { class: 'btn secondary', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.name })));
  $('analogs-search-box').classList.toggle('hidden', !data.can_edit);
  $('analogs-form').classList.toggle('hidden', !data.can_edit);
  $('analogs-ai-note').textContent = data.ocr
    ? 'ИИ прочитает скриншот и сам заполнит цену и признаки — Вам останется проверить и подтвердить.'
    : 'ИИ заполнит цену и признаки по PDF страницы или по вставленному тексту — Вам останется проверить и подтвердить.';
  $('analogs-list').replaceChildren(...data.analogs.map((a, i) => card(a, i, data)));
}

function input(f, a, disabled) {
  const id = `analog-${a.id}-${f.id}`;
  const v = a.fields[f.id];
  let node;
  if (f.type === 'select') {
    node = el('select', { id }, el('option', { value: '', text: '—' }), ...f.options.map((o) => el('option', { value: o.id, text: o.name })));
    node.value = v ?? '';
  } else {
    const attrs = { id, type: f.id === 'listed_on' ? 'date' : 'text', autocomplete: 'off' };
    if (f.type === 'number') attrs.inputmode = f.integer || f.id === 'price_rub' ? 'numeric' : 'decimal';
    if (f.max && f.type !== 'number') attrs.maxlength = String(f.max);
    node = el('input', attrs);
    node.value = v === undefined || v === null ? '' : String(v);
  }
  node.disabled = disabled;
  node.setAttribute('data-field', f.id);
  const fromAi = !a.confirmed && a.suggested && a.suggested[f.id] !== undefined && a.suggested[f.id] === v;
  if (fromAi) node.classList.add('from-ai');
  const label = el('label', { for: id, text: f.label + (f.required ? ' *' : '') });
  if (fromAi) label.append(el('span', { class: 'ai-tag', text: 'ИИ' }));
  const wide = f.type === 'text' && (f.max ?? 300) > 40;
  return el('div', { class: `field${wide ? ' full' : ''}` }, label, node);
}

function card(a, i, data) {
  const ro = !data.can_edit;
  const fieldsBox = el('div', { class: 'analog-fields' }, ...data.fields.map((f) => input(f, a, ro)));
  const fileId = `analog-file-${a.id}`;
  const meta = a.file
    ? `Скриншот получен платформой ${timeRu(a.file.received_at)} · отпечаток ${a.file.sha256.slice(0, 12)}…`
    : 'Скриншот не приложен';
  const actions = ro ? [] : [
    el('button', { type: 'button', 'data-action': 'analog-confirm', onclick: (e) => save(a, fieldsBox, true, e.target) }, a.confirmed ? 'Сохранить' : 'Подтвердить'),
    el('button', { type: 'button', class: 'secondary', 'data-action': 'analog-ai', onclick: (e) => readAi(a, e.target) }, 'Заполнить с помощью ИИ'),
    el('label', { class: 'btn secondary', for: fileId, text: a.file ? 'Заменить скриншот' : 'Приложить скриншот' }),
    el('input', { id: fileId, type: 'file', class: 'visually-hidden', accept: 'image/png,image/jpeg,image/webp,image/heic,application/pdf', onchange: (e) => replaceFile(a, e) }),
    el('button', { type: 'button', class: 'danger', onclick: (e) => remove(a, e.target) }, 'Убрать'),
  ];
  return el('li', { class: 'analog', 'data-analog': a.id },
    el('div', { class: 'head' },
      el('span', { class: 'title', text: `Аналог ${i + 1} · ${a.host}` }),
      el('span', { class: a.confirmed ? 'badge' : 'badge overdue', text: a.confirmed ? 'подтверждён' : 'не подтверждён' })),
    el('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: a.url }),
    el('div', { class: 'photo-meta', text: meta }),
    ...(a.file ? [el('button', { type: 'button', class: 'link', onclick: () => openFile(a) }, 'Открыть скриншот')] : []),
    ...(a.warnings.length ? [el('ul', { class: 'analog-warn' }, ...a.warnings.map((w) => el('li', { text: w })))] : []),
    fieldsBox,
    el('div', { class: 'row' }, ...actions));
}

async function run(button, work) {
  if (button) button.disabled = true;
  try { await work(); } catch (err) { say($('analogs-msg'), err.message); } finally { if (button) button.disabled = false; }
}

const base = () => `/api/orders/${ctx.order.id}/analogs`;
const upload = (id, file) => api('POST', `${base()}/${id}/file`, file, { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) });

function pickedFile(input) {
  const file = input.files[0];
  if (!file) return null;
  if (file.size > MAX_FILE) throw new Error('Файл больше 10 МБ — сделайте скриншот поменьше или PDF одной страницы');
  return file;
}

$('analogs-file').addEventListener('change', () => {
  const f = $('analogs-file').files[0];
  $('analogs-file-name').textContent = f ? f.name : 'Файл не выбран';
});

// Один шаг для эксперта: ссылка + скриншот (+ текст) → аналог, файл и предложение ИИ сразу.
$('analogs-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run($('analogs-add'), async () => {
    const url = $('analogs-url').value.trim();
    if (!url) return say($('analogs-msg'), 'Вставьте ссылку на объявление');
    const file = pickedFile($('analogs-file'));
    const text = $('analogs-text').value.trim();
    const r = await api('POST', base(), { url });
    let data = r;
    if (file) data = await upload(r.id, file);
    let note = 'Аналог добавлен — заполните признаки и подтвердите';
    if (file || text) {
      say($('analogs-msg'), 'ИИ читает объявление…', 'ok');
      try {
        const ai = await api('POST', `${base()}/${r.id}/ai`, { text });
        data = ai;
        note = ai.found ? `ИИ заполнил признаков: ${ai.found} — проверьте их (отмечены «ИИ») и подтвердите` : 'ИИ ничего не нашёл в объявлении — заполните признаки сами';
      } catch (err) { note = `Аналог добавлен. ${err.message}`; }
    }
    $('analogs-form').reset();
    $('analogs-file-name').textContent = 'Файл не выбран';
    render(data);
    say($('analogs-msg'), note, 'ok');
    document.querySelector(`[data-analog="${r.id}"]`)?.scrollIntoView({ block: 'start' });
  });
});

function values(box) {
  const out = {};
  for (const n of box.querySelectorAll('[data-field]')) out[n.getAttribute('data-field')] = n.value.trim();
  return out;
}

const save = (a, box, confirm, button) => run(button, async () => {
  render(await api('PUT', `${base()}/${a.id}`, { fields: values(box), confirm }));
  say($('analogs-msg'), confirm ? 'Аналог подтверждён' : 'Сохранено', 'ok');
});

const readAi = (a, button) => run(button, async () => {
  const box = document.querySelector(`[data-analog="${a.id}"] .analog-fields`);
  // Что эксперт уже ввёл — сохраняется до чтения: ИИ заполняет только пустое.
  await api('PUT', `${base()}/${a.id}`, { fields: values(box), confirm: false });
  say($('analogs-msg'), 'ИИ читает объявление…', 'ok');
  const r = await api('POST', `${base()}/${a.id}/ai`, {});
  render(r);
  say($('analogs-msg'), r.found ? `ИИ заполнил признаков: ${r.found} — проверьте и подтвердите` : 'ИИ ничего не нашёл — заполните сами', 'ok');
});

async function replaceFile(a, e) {
  await run(null, async () => {
    const file = pickedFile(e.target);
    e.target.value = '';
    if (!file) return;
    render(await upload(a.id, file));
    say($('analogs-msg'), 'Скриншот приложен — подтвердите признаки заново', 'ok');
  });
}

const remove = (a, button) => run(button, async () => {
  if (!confirm('Убрать аналог из дела? В отчёт он больше не попадёт.')) return;
  render(await api('DELETE', `${base()}/${a.id}`));
  say($('analogs-msg'), 'Аналог убран', 'ok');
});

const openFile = (a) => run(null, async () => {
  const { url } = await api('GET', `${base()}/${a.id}/file`);
  window.open(url, '_blank', 'noopener');
});
