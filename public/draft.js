// Черновик заключения от ИИ (задача 2.2): исполнитель готовит черновик, правит его и прикладывает файлом результата;
// диспетчер только читает; заказчику блок не показывается (и сервер ему черновик не отдаёт). Тексты — через textContent.
import { api, say } from '/common.js';
import { state } from '/shell.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const GAP = /\[(?:заполнить|описать)[^\]]*\]/gi;
let ctx = null;   // { order, draft, reload }

export async function loadDraft(current, reload) {
  const box = $('draft-box');
  const staff = ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  const mine = !!current.executor?.is_me;
  if (!current.order.module || (!mine && !staff)) { box.classList.add('hidden'); return; }
  say($('draft-msg'), '');
  const r = await api('GET', `/api/orders/${current.order.id}/draft`);
  ctx = { order: current.order, draft: r.draft, reload };
  // Исполнителю — пока дело в работе или черновик есть; служебным — только когда черновик есть.
  box.classList.toggle('hidden', !(r.can_ai || r.draft));
  if (box.classList.contains('hidden')) return;
  $('draft-ai').classList.toggle('hidden', !r.can_ai);
  $('draft-ai').textContent = r.draft ? 'Подготовить заново с помощью ИИ' : 'Подготовить черновик с помощью ИИ';
  $('draft-edit').classList.toggle('hidden', !r.draft);
  $('draft-actions').classList.toggle('hidden', !(r.draft && r.can_edit));
  $('draft-text').readOnly = !r.can_edit;
  $('draft-text').value = r.draft?.body ?? '';
  $('draft-confirm').checked = false;
  $('draft-state').textContent = stateText(r);
}

function stateText(r) {
  const d = r.draft;
  if (!d) {
    return 'ИИ подготовит черновик по данным заявки, документам и списку фото. Это только помощь: расчёт, выводы и описание '
      + 'фото — за Вами; заказчик черновик не увидит.';
  }
  const gaps = (d.body.match(GAP) ?? []).length;
  return [
    d.source === 'ai' ? `Черновик подготовил ИИ ${timeRu(d.at)} — проверьте каждое слово и число.` : `Последняя правка — ${timeRu(d.at)}.`,
    d.inputs?.photos?.length ? `Фото в черновике: ${d.inputs.photos.length} (сами снимки ИИ не видит — опишите их).` : null,
    gaps ? `Осталось заполнить мест: ${gaps} (в квадратных скобках).` : null,
    r.can_edit ? 'Итоговый файл приложите, когда текст готов: он уйдёт на проверку вместе с результатом.' : 'Черновик видят только исполнитель и диспетчер.',
  ].filter(Boolean).join(' ');
}

async function run(button, work) {
  button.disabled = true;
  try { await work(); } catch (err) { say($('draft-msg'), err.message); } finally { button.disabled = false; }
}

$('draft-ai').addEventListener('click', () => run($('draft-ai'), async () => {
  if (ctx.draft && !confirm('Подготовить черновик заново? Текущий текст останется в истории, но на экране его заменит новый.')) return;
  say($('draft-msg'), 'ИИ готовит черновик…', 'ok');
  await api('POST', `/api/orders/${ctx.order.id}/draft/ai`, { from: ctx.draft?.id ?? null });
  await loadDraft({ order: ctx.order, executor: { is_me: true } }, ctx.reload);
  say($('draft-msg'), 'Черновик готов — проверьте и поправьте', 'ok');
}));

async function save() {
  const r = await api('PUT', `/api/orders/${ctx.order.id}/draft`, { body: $('draft-text').value, from: ctx.draft?.id ?? null });
  ctx.draft = r.draft;
  $('draft-state').textContent = stateText({ draft: r.draft, can_edit: true });
}

$('draft-save').addEventListener('click', () => run($('draft-save'), async () => {
  await save();
  say($('draft-msg'), 'Правка сохранена', 'ok');
}));

$('draft-attach').addEventListener('click', () => run($('draft-attach'), async () => {
  if (!$('draft-confirm').checked) return say($('draft-msg'), 'Отметьте, что Вы проверили текст и отвечаете за него');
  if ($('draft-text').value.trim() !== ctx.draft.body) await save();
  await api('POST', `/api/orders/${ctx.order.id}/draft/result`, { from: ctx.draft.id, confirm: true });
  await ctx.reload();
  say($('draft-msg'), 'Файл «Заключение.docx» добавлен в результат работы', 'ok');
}));
