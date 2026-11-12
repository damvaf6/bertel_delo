// Повреждённые детали таблицей (задача 2.471, «Ущерб автомобилю после ДТП»). Эксперт дела, пока дело в работе: деталь,
// повреждение, ремонтное воздействие (замена, ремонт, окраска) и номера фото осмотра — таблица в раздел «Исследование
// повреждений» черновика (при подготовке ИИ — программой, здесь — кнопкой) и оттуда в Word. Остальные стороны дела видят
// список. Текст — через textContent.
import { api, el, say } from '/common.js';
import { insertPartsTable } from '/draft.js';

const $ = (id) => document.getElementById(id);
let ctx = null; // { orderId, v, editing }

export async function loadParts(current) {
  const orderId = current.order.id;
  ctx = { orderId, v: null, editing: null };
  $('parts-box').classList.add('hidden');
  $('parts-form').classList.add('hidden');
  say($('parts-msg'), '');
  try {
    const v = await api('GET', `/api/orders/${orderId}/parts`);
    if (ctx?.orderId !== orderId || !v.available || (!v.parts.length && !v.can_write)) return;
    draw(v);
  } catch { /* блок — дополнение к делу; не загрузился — дело открывается как обычно */ }
}

function draw(v) {
  ctx.v = v;
  $('parts-box').classList.remove('hidden');
  $('parts-lead').textContent = !v.parts.length
    ? 'Запишите каждую повреждённую деталь: что с ней, что делать (замена, ремонт, окраска) и на каких фото осмотра видно. Таблица попадёт в раздел «Исследование повреждений» черновика и в отчёт Word.'
    : `Деталей: ${v.parts.length}.${v.parts.some((p) => !p.photos.length) ? ' Без фото осмотра: ' + v.parts.filter((p) => !p.photos.length).length + '.' : ''}`;
  $('parts-list').replaceChildren(...v.parts.map((p) => item(p, v)));
  $('parts-draft-row').classList.toggle('hidden', !v.can_write || !v.table);
  $('parts-open').classList.toggle('hidden', !v.can_write || v.parts.length >= v.max || !$('parts-form').classList.contains('hidden'));
  if (!v.can_write) $('parts-form').classList.add('hidden');
  if (!$('parts-actions').querySelector('input')) {
    $('parts-actions').append(...v.actions.map((a) => el('label', { class: 'row check-line' },
      el('input', { type: 'checkbox', value: a.id, name: 'parts-action' }), el('span', {}, a.name))));
  }
  $('parts-photos-hint').textContent = v.photos.length
    ? `В деле ${v.photos.length} фото осмотра: ${v.photos.slice(0, 12).map((p) => `${p.no} — ${p.step}`).join('; ')}${v.photos.length > 12 ? '; …' : ''}.`
    : 'Фото осмотра в деле пока нет — номера можно добавить позже.';
}

function item(p, v) {
  const li = el('li', { 'data-part': p.id },
    el('strong', {}, `${p.no}. ${p.part}`),
    el('p', {}, p.damage),
    el('p', { class: 'muted' }, `${cap(p.action_names.join(', '))} · ${p.photos.length ? `фото ${p.photos.join(', ')}` : 'нет фото осмотра'}`));
  if (v.can_write) li.append(el('div', { class: 'row' },
    el('button', { type: 'button', class: 'link', onclick: () => openForm(p) }, 'Изменить'),
    el('button', { type: 'button', class: 'link', onclick: () => send('DELETE', `/parts/${p.id}`, undefined, 'Деталь удалена') }, 'Удалить')));
  return li;
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function openForm(p = null) {
  ctx.editing = p?.id ?? null;
  $('parts-part').value = p?.part ?? '';
  $('parts-damage').value = p?.damage ?? '';
  for (const c of $('parts-actions').querySelectorAll('input')) c.checked = !!p?.actions.includes(c.value);
  $('parts-photos').value = p?.photos.join(', ') ?? '';
  $('parts-save').textContent = p ? 'Сохранить деталь' : 'Записать деталь';
  $('parts-form').classList.remove('hidden');
  $('parts-open').classList.add('hidden');
  $('parts-form').scrollIntoView({ block: 'center' });
  $('parts-part').focus();
}
function closeForm() {
  ctx.editing = null;
  $('parts-form').classList.add('hidden');
  $('parts-open').classList.toggle('hidden', !ctx.v?.can_write || ctx.v.parts.length >= ctx.v.max);
}

async function send(method, path, body, ok) {
  try {
    draw(await api(method, `/api/orders/${ctx.orderId}${path}`, body));
    say($('parts-msg'), ok, 'ok');
    return true;
  } catch (err) { say($('parts-msg'), err.message); return false; }
}

// «3, 5 7;9» → [3, 5, 7, 9]; не число — как есть, сервер ответит, какого фото нет.
const photoList = (s) => s.split(/[\s,;]+/).map((x) => x.replace(/^№/, '').trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));

$('parts-open').addEventListener('click', () => openForm());
$('parts-cancel').addEventListener('click', closeForm);
$('parts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    part: $('parts-part').value, damage: $('parts-damage').value,
    actions: [...$('parts-actions').querySelectorAll('input:checked')].map((c) => c.value),
    photos: photoList($('parts-photos').value),
  };
  const edit = ctx.editing;
  const done = await send(edit ? 'PUT' : 'POST', edit ? `/parts/${edit}` : '/parts', body, edit ? 'Деталь сохранена' : 'Деталь записана');
  if (done) closeForm();
});

$('parts-draft').addEventListener('click', async () => {
  try {
    const done = await insertPartsTable(ctx.v?.table);
    if (done === 'same') say($('parts-msg'), 'Эта таблица уже есть в черновике.', 'ok');
    else if (done) say($('parts-msg'), 'Таблица вставлена в раздел «Исследование повреждений», черновик сохранён.', 'ok');
    else say($('parts-msg'), 'Черновик сейчас не правится — откройте блок черновика выше.');
  } catch (err) { say($('parts-msg'), err.message); }
});
