// Проверка в реестре залогов (задача 2.491, «Оценка транспорта»). Эксперт дела проверяет машину по VIN в реестре
// уведомлений о залоге движимого имущества и отмечает дату и итог: залога нет или есть — номер уведомления и
// залогодержатель. Итог — строкой в раздел «Описание объекта» черновика (при подготовке ИИ — программой, здесь —
// кнопкой); ИИ-проверка сверяет с ним отчёт. Остальные стороны дела видят итог. Текст — через textContent.
import { api, say } from '/common.js';
import { insertHeadLine } from '/draft.js';

const $ = (id) => document.getElementById(id);
const todayMsk = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
let ctx = null; // { orderId, v }

export async function loadPledge(current) {
  const orderId = current.order.id;
  ctx = { orderId, v: null };
  $('pledge-box').classList.add('hidden');
  $('pledge-form').classList.add('hidden');
  say($('pledge-msg'), '');
  try {
    const v = await api('GET', `/api/orders/${orderId}/pledge`);
    if (ctx?.orderId !== orderId || !v.available || (!v.check && !v.can_write)) return;
    draw(v);
  } catch { /* блок — дополнение к делу; не загрузился — дело открывается как обычно */ }
}

function draw(v) {
  ctx.v = v;
  const formOpen = !$('pledge-form').classList.contains('hidden');
  $('pledge-box').classList.remove('hidden');
  $('pledge-lead').textContent = v.check ? '' : `Проверьте машину${v.vin ? ` по VIN ${v.vin}` : ' по VIN'} в реестре уведомлений о залоге движимого имущества (reestr-zalogov.ru) и отметьте здесь дату и итог — строка попадёт в описание объекта черновика, а ИИ-проверка сверит с ней отчёт.`;
  $('pledge-lead').classList.toggle('hidden', !$('pledge-lead').textContent);
  $('pledge-line').textContent = v.line ?? '';
  $('pledge-line').classList.toggle('hidden', !v.line);
  $('pledge-line').classList.toggle('notice-warn', v.check?.result === 'found');
  $('pledge-draft-row').classList.toggle('hidden', !v.can_write || !v.line || formOpen);
  $('pledge-open').textContent = v.check ? 'Изменить отметку' : 'Отметить проверку';
  $('pledge-open').classList.toggle('hidden', !v.can_write || formOpen);
  $('pledge-delete').classList.toggle('hidden', !v.can_write || !v.check || formOpen);
  if (!v.can_write) $('pledge-form').classList.add('hidden');
}

const result = () => document.querySelector('input[name="pledge-result"]:checked')?.value;
const toggleFound = () => $('pledge-found').classList.toggle('hidden', result() !== 'found');

function openForm() {
  const c = ctx.v?.check;
  $('pledge-date').value = c?.checked_on ?? todayMsk();
  $('pledge-date').max = todayMsk();
  for (const r of document.querySelectorAll('input[name="pledge-result"]')) r.checked = r.value === (c?.result ?? 'none');
  $('pledge-notice').value = c?.notice_no ?? '';
  $('pledge-pledgee').value = c?.pledgee ?? '';
  toggleFound();
  $('pledge-form').classList.remove('hidden');
  draw(ctx.v);
  $('pledge-form').scrollIntoView({ block: 'center' });
  $('pledge-date').focus();
}
function closeForm() {
  $('pledge-form').classList.add('hidden');
  if (ctx?.v) draw(ctx.v);
}

async function send(method, body, ok) {
  try {
    const v = await api(method, `/api/orders/${ctx.orderId}/pledge`, body);
    $('pledge-form').classList.add('hidden');
    draw(v);
    say($('pledge-msg'), ok, 'ok');
  } catch (err) { say($('pledge-msg'), err.message); }
}

for (const r of document.querySelectorAll('input[name="pledge-result"]')) r.addEventListener('change', toggleFound);
$('pledge-open').addEventListener('click', openForm);
$('pledge-cancel').addEventListener('click', closeForm);
$('pledge-delete').addEventListener('click', () => send('DELETE', undefined, 'Отметка убрана. Из черновика строку уберите сами, если вставляли.'));
$('pledge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await send('PUT', { checked_on: $('pledge-date').value, result: result(), notice_no: $('pledge-notice').value, pledgee: $('pledge-pledgee').value },
    'Записано. Вставьте строку в черновик кнопкой выше.');
});
$('pledge-draft').addEventListener('click', async () => {
  try {
    const done = await insertHeadLine(ctx.v?.line, 'Проверка в реестре залогов:', 'pledge');
    if (done === 'same') say($('pledge-msg'), 'Эта строка уже есть в черновике.', 'ok');
    else if (done) say($('pledge-msg'), 'Строка о проверке вставлена в раздел «Описание объекта», черновик сохранён.', 'ok');
    else say($('pledge-msg'), 'Черновик сейчас не правится — откройте блок черновика выше.');
  } catch (err) { say($('pledge-msg'), err.message); }
});
