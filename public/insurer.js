// Сверка с актом и расчётом страховой (задача 2.475, «Ущерб автомобилю после ДТП»). Эксперт дела, пока дело в работе,
// вносит детали из акта страховой, её сумму и свою; программа сравнивает с таблицей повреждённых деталей — совпадает,
// добавлено, исключено — и считает разницу. Блок — в раздел «Исследование повреждений» черновика (кнопкой) и в Word.
// Остальные стороны дела видят итог и список. Текст — через textContent.
import { api, el, say } from '/common.js';
import { insertInsurerBlock } from '/draft.js';

const $ = (id) => document.getElementById(id);
let ctx = null; // { orderId, v }

export async function loadInsurer(current) {
  const orderId = current.order.id;
  ctx = { orderId, v: null };
  $('insurer-box').classList.add('hidden');
  $('insurer-form').classList.add('hidden');
  say($('insurer-msg'), '');
  await refreshInsurer();
}

// Таблица деталей изменилась — сравнение пересчитывается.
export async function refreshInsurer() {
  const orderId = ctx?.orderId;
  if (!orderId) return;
  try {
    const v = await api('GET', `/api/orders/${orderId}/insurer`);
    if (ctx?.orderId !== orderId || !v.available || (!v.calc && !v.can_write)) return;
    draw(v);
  } catch { /* блок — дополнение к делу; не загрузился — дело открывается как обычно */ }
}

const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')}${kop % 100 ? `,${String(kop % 100).padStart(2, '0')}` : ''}`;
const KIND = { both: 'совпадает', added: 'добавлено Вами', excluded: 'исключено Вами' };

function draw(v) {
  ctx.v = v;
  const formOpen = !$('insurer-form').classList.contains('hidden');
  $('insurer-box').classList.remove('hidden');
  $('insurer-lead').textContent = !v.calc
    ? 'Если страховая уже осмотрела машину и посчитала ремонт, внесите детали из её акта и её сумму — программа сравнит их с Вашей таблицей деталей: что Вы добавили, что исключили, и разницу в рублях. Сверка попадёт в черновик и в отчёт Word.'
    : (v.our_parts ? '' : 'В таблице повреждённых деталей пока пусто — все детали страховой считаются исключёнными, пока Вы их не запишете.');
  $('insurer-lead').classList.toggle('hidden', !$('insurer-lead').textContent);
  $('insurer-line').classList.toggle('hidden', !v.line);
  $('insurer-line').textContent = v.line ?? '';
  const rows = v.compare?.rows ?? [];
  $('insurer-list').replaceChildren(...rows.map((r) => el('li', { 'data-kind': r.kind },
    el('strong', {}, r.part),
    el('p', { class: r.kind === 'both' ? 'muted' : '' }, r.kind === 'both' && r.insurer.toLowerCase() !== r.part.toLowerCase() ? `${KIND[r.kind]} (у страховой — «${r.insurer}»)` : KIND[r.kind]))));
  $('insurer-draft-row').classList.toggle('hidden', !v.can_write || !v.block);
  $('insurer-open').textContent = v.calc ? 'Изменить акт и расчёт страховой' : 'Внести акт и расчёт страховой';
  $('insurer-open').classList.toggle('hidden', !v.can_write || formOpen);
  $('insurer-delete').classList.toggle('hidden', !v.can_write || !v.calc || formOpen);
  if (!v.can_write) $('insurer-form').classList.add('hidden');
}

function openForm() {
  const c = ctx.v?.calc;
  $('insurer-basis').value = c?.basis ?? '';
  $('insurer-parts').value = (c?.parts ?? []).join('\n');
  for (const r of document.querySelectorAll('input[name="insurer-wear"]')) r.checked = r.value === (c?.wear ?? 'with');
  $('insurer-sum').value = c ? rub(c.insurer_kop) : '';
  $('insurer-own').value = c?.own_kop != null ? rub(c.own_kop) : '';
  $('insurer-form').classList.remove('hidden');
  $('insurer-open').classList.add('hidden');
  $('insurer-delete').classList.add('hidden');
  $('insurer-form').scrollIntoView({ block: 'center' });
  $('insurer-basis').focus();
}
function closeForm() {
  $('insurer-form').classList.add('hidden');
  if (ctx?.v) draw(ctx.v);
}

async function send(method, body, ok) {
  try {
    const v = await api(method, `/api/orders/${ctx.orderId}/insurer`, body);
    $('insurer-form').classList.add('hidden');
    draw(v);
    say($('insurer-msg'), ok, 'ok');
    return true;
  } catch (err) { say($('insurer-msg'), err.message); return false; }
}

$('insurer-open').addEventListener('click', openForm);
$('insurer-cancel').addEventListener('click', closeForm);
$('insurer-delete').addEventListener('click', () => send('DELETE', undefined, 'Сверка убрана. Из черновика её уберите сами, если вставляли.'));
$('insurer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await send('PUT', {
    basis: $('insurer-basis').value,
    parts: $('insurer-parts').value,
    wear: document.querySelector('input[name="insurer-wear"]:checked')?.value,
    insurer: $('insurer-sum').value,
    own: $('insurer-own').value,
  }, 'Сравнено с Вашей таблицей деталей');
});

$('insurer-draft').addEventListener('click', async () => {
  try {
    const done = await insertInsurerBlock(ctx.v?.block);
    if (done === 'same') say($('insurer-msg'), 'Эта сверка уже есть в черновике.', 'ok');
    else if (done) say($('insurer-msg'), 'Сверка вставлена в раздел «Исследование повреждений», черновик сохранён.', 'ok');
    else say($('insurer-msg'), 'Черновик сейчас не правится — откройте блок черновика выше.');
  } catch (err) { say($('insurer-msg'), err.message); }
});
