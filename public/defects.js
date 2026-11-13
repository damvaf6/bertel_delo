// Недостатки товара таблицей (задача 2.482, товароведческая экспертиза). Эксперт дела, пока дело в работе: недостаток,
// где и какой размер, характер (производственный, эксплуатационный, не установлен, не подтвердился), признаки и номера фото
// осмотра — таблица в раздел «5. Исследование» черновика (при подготовке ИИ — программой, здесь — кнопкой) и оттуда в Word.
// Недостатки из заявки, которых ещё нет в таблице, — подсказкой и в форму одним нажатием. Остальные стороны дела видят
// список. Текст — через textContent.
import { api, el, say } from '/common.js';
import { insertPartsTable } from '/draft.js';

const $ = (id) => document.getElementById(id);
let ctx = null; // { orderId, v, editing }

export async function loadDefects(current) {
  const orderId = current.order.id;
  ctx = { orderId, v: null, editing: null };
  $('defects-box').classList.add('hidden');
  $('defects-form').classList.add('hidden');
  say($('defects-msg'), '');
  try {
    const v = await api('GET', `/api/orders/${orderId}/defects`);
    if (ctx?.orderId !== orderId || !v.available || (!v.defects.length && !v.can_write)) return;
    draw(v);
  } catch { /* блок — дополнение к делу; не загрузился — дело открывается как обычно */ }
}

function draw(v) {
  ctx.v = v;
  $('defects-box').classList.remove('hidden');
  const noPhoto = v.defects.filter((d) => !d.photos.length).length;
  $('defects-lead').textContent = !v.defects.length
    ? 'Запишите каждый недостаток: где он и какой размер, характер (производственный, эксплуатационный, не установлен или не подтвердился), по каким признакам и на каких фото осмотра виден. Таблица попадёт в раздел «Исследование» черновика и в заключение Word.'
    : `Недостатков: ${v.defects.length}.${noPhoto ? ` Без фото осмотра: ${noPhoto}.` : ''}`;
  const claimed = $('defects-claimed');
  claimed.classList.toggle('hidden', !v.can_write || !v.claimed.length);
  claimed.replaceChildren(...(v.claimed.length ? [
    el('span', {}, 'Из заявки ещё не записаны: '),
    ...v.claimed.flatMap((c, i) => [...(i ? [el('span', {}, ', ')] : []),
      el('button', { type: 'button', class: 'link', 'data-claimed': c, onclick: () => openForm(null, c, v.claimed_photos?.[c]) }, c)]),
  ] : []));
  $('defects-list').replaceChildren(...v.defects.map((d) => item(d, v)));
  $('defects-draft-row').classList.toggle('hidden', !v.can_write || !v.table);
  $('defects-open').classList.toggle('hidden', !v.can_write || v.defects.length >= v.max || !$('defects-form').classList.contains('hidden'));
  if (!v.can_write) $('defects-form').classList.add('hidden');
  if (!$('defects-natures').querySelector('input')) {
    $('defects-natures').append(...v.natures.map((a) => el('label', { class: 'row check-line' },
      el('input', { type: 'radio', value: a.id, name: 'defects-nature' }), el('span', {}, a.name))));
  }
  $('defects-photos-hint').textContent = v.photos.length
    ? `В деле ${v.photos.length} фото осмотра: ${v.photos.slice(0, 12).map((p) => `${p.no} — ${p.step}`).join('; ')}${v.photos.length > 12 ? '; …' : ''}.`
    : 'Фото осмотра в деле пока нет — номера можно добавить позже.';
}

function item(d, v) {
  const li = el('li', { 'data-defect': d.id },
    el('strong', {}, `${d.no}. ${d.defect}`),
    el('p', {}, d.place),
    el('p', { class: 'muted' }, `${cap(d.nature_name)} · ${d.photos.length ? `фото ${d.photos.join(', ')}` : 'нет фото осмотра'}`));
  if (d.signs) li.append(el('p', { class: 'muted' }, `Признаки: ${d.signs}`));
  if (v.can_write) li.append(el('div', { class: 'row' },
    el('button', { type: 'button', class: 'link', onclick: () => openForm(d) }, 'Изменить'),
    el('button', { type: 'button', class: 'link', onclick: () => send('DELETE', `/defects/${d.id}`, undefined, 'Недостаток удалён') }, 'Удалить')));
  return li;
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function openForm(d = null, name = '', shots = null) {
  ctx.editing = d?.id ?? null;
  $('defects-defect').value = d?.defect ?? (name ? cap(name) : '');
  $('defects-place').value = d?.place ?? '';
  for (const c of $('defects-natures').querySelectorAll('input')) c.checked = d?.nature === c.value;
  $('defects-signs').value = d?.signs ?? '';
  // 2.483: недостаток из заявки — номера фото его шага осмотра «Недостаток крупно: …» сразу в поле.
  $('defects-photos').value = d?.photos.join(', ') ?? (shots?.length ? shots.join(', ') : '');
  $('defects-save').textContent = d ? 'Сохранить недостаток' : 'Записать недостаток';
  $('defects-form').classList.remove('hidden');
  $('defects-open').classList.add('hidden');
  $('defects-form').scrollIntoView({ block: 'center' });
  (name ? $('defects-place') : $('defects-defect')).focus();
}
function closeForm() {
  ctx.editing = null;
  $('defects-form').classList.add('hidden');
  $('defects-open').classList.toggle('hidden', !ctx.v?.can_write || ctx.v.defects.length >= ctx.v.max);
}

async function send(method, path, body, ok) {
  try {
    draw(await api(method, `/api/orders/${ctx.orderId}${path}`, body));
    say($('defects-msg'), ok, 'ok');
    return true;
  } catch (err) { say($('defects-msg'), err.message); return false; }
}

// «3, 5 7;9» → [3, 5, 7, 9]; не число — как есть, сервер ответит, какого фото нет.
const photoList = (s) => s.split(/[\s,;]+/).map((x) => x.replace(/^№/, '').trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));

$('defects-open').addEventListener('click', () => openForm());
$('defects-cancel').addEventListener('click', closeForm);
$('defects-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    defect: $('defects-defect').value, place: $('defects-place').value,
    nature: $('defects-natures').querySelector('input:checked')?.value ?? '',
    signs: $('defects-signs').value,
    photos: photoList($('defects-photos').value),
  };
  const edit = ctx.editing;
  const done = await send(edit ? 'PUT' : 'POST', edit ? `/defects/${edit}` : '/defects', body, edit ? 'Недостаток сохранён' : 'Недостаток записан');
  if (done) closeForm();
});

$('defects-draft').addEventListener('click', async () => {
  try {
    const done = await insertPartsTable(ctx.v?.table, 'defects');
    if (done === 'same') say($('defects-msg'), 'Эта таблица уже есть в черновике.', 'ok');
    else if (done) say($('defects-msg'), 'Таблица вставлена в раздел «Исследование», черновик сохранён.', 'ok');
    else say($('defects-msg'), 'Черновик сейчас не правится — откройте блок черновика выше.');
  } catch (err) { say($('defects-msg'), err.message); }
});
