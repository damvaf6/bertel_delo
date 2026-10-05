// «Сообщить о проблеме» (2.54): кнопка внизу каждого экрана кабинета — человек пишет, что случилось; раздел кабинета и
// экран подставляются сами. Журнал сообщений — раздел «Проблемы» у диспетчера и администратора (#problems).
import { api, el, say, formatPhone } from '/common.js';
import { show } from '/shell.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

$('report-open').addEventListener('click', () => {
  $('report-form').classList.remove('hidden');
  $('report-open').classList.add('hidden');
  say($('report-msg'), '');
  $('report-text').focus();
});
$('report-cancel').addEventListener('click', () => {
  $('report-form').classList.add('hidden');
  $('report-open').classList.remove('hidden');
});
$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('report-send');
  btn.disabled = true;
  try {
    const client = `экран ${window.innerWidth}×${window.innerHeight} · ${navigator.userAgent}`;
    const r = await api('POST', '/api/problems', { text: $('report-text').value, place: location.hash, client });
    $('report-text').value = '';
    $('report-form').classList.add('hidden');
    $('report-open').classList.remove('hidden');
    say($('report-done'), `Спасибо! Сообщение № ${r.id} записано, мы разберёмся.`, 'ok');
  } catch (err) {
    say($('report-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});

export async function showProblems() {
  show('problems-view', 'problems');
  const { problems, open } = await api('GET', '/api/problems');
  $('problems-count').textContent = open ? `Не разобрано: ${open}` : 'Все сообщения разобраны';
  $('problems-empty').classList.toggle('hidden', problems.length > 0);
  $('problems').replaceChildren(...problems.map((p) => {
    const li = el('li', { 'data-id': p.id },
      el('div', { class: 'row' },
        el('span', { class: `badge${p.closed_at ? '' : ' warn'}`, text: p.closed_at ? 'разобрано' : 'новое' }),
        el('span', { class: 'muted', text: `№ ${p.id} · ${dateRu(p.created_at)}` })),
      el('div', { class: 'title', text: p.text }),
      el('div', { class: 'muted', text: `${p.who.name || 'без имени'} · ${formatPhone(p.who.phone)}` }));
    if (p.place) li.append(el('a', { class: 'link', href: p.place, text: 'Открыть место в кабинете' }));
    if (p.client) li.append(el('div', { class: 'muted small', text: p.client }));
    if (p.closed_at) {
      li.append(el('div', { class: 'muted', text: `Разобрал(а): ${p.closed_by || '—'}, ${dateRu(p.closed_at)}${p.note ? ` · ${p.note}` : ''}` }));
    } else {
      const note = el('input', { type: 'text', maxlength: '1000', placeholder: 'Что сделано (можно не писать)', 'aria-label': `Что сделано по сообщению № ${p.id}` });
      const msg = el('p', { class: 'msg', role: 'status' });
      li.append(el('div', { class: 'row gap' }, note,
        el('button', { class: 'secondary', onclick: async () => {
          try { await api('POST', `/api/problems/${p.id}/close`, { note: note.value }); await showProblems(); } catch (err) { say(msg, err.message); }
        } }, 'Разобрано')), msg);
    }
    return li;
  }));
}
