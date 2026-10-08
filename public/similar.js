// Мои похожие дела (задача 2.129). Исполнителю в деле — свои сданные дела той же услуги и того же вида объекта за год:
// номер дела, дата сдачи, вид объекта, цель и место оценки. «Открыть заключение» — файл своего прошлого дела как образец
// (в новое дело ничего не переносится), «Открыть дело» — само прошлое дело. Названий, адресов и имён прошлых заказчиков
// здесь нет. Блок сворачивается, как другие блоки дела (fold.js). Текст — через textContent.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const dayRu = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const size = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

export async function loadSimilar(current) {
  const box = $('similar-box');
  say($('similar-msg'), '');
  const hide = () => { box.classList.add('hidden'); setNext({ similar: null }); };
  if (!current.executor?.is_me || current.order.status !== 'in_work') return hide();
  let r;
  try { r = await api('GET', `/api/orders/${current.order.id}/similar`); } catch { return hide(); }
  if (!r.cases.length) return hide();
  box.classList.remove('hidden');
  $('similar-lead').textContent = `${r.kind ? `${r.kind}: ` : ''}Ваши сданные дела этой услуги за год. Своё прошлое заключение можно открыть как образец — в это дело из него ничего не переносится.`;
  $('similar-list').replaceChildren(...r.cases.map(item));
  setNext({ similar: `дел: ${r.cases.length}` });
}

function item(c) {
  const about = [c.kind, c.purpose, c.region].filter(Boolean).join(' · ');
  return el('li', { 'data-similar-case': c.id },
    el('div', { class: 'title', text: `Дело ${c.ref} · сдано ${dayRu(c.done_at)}` }),
    el('div', { class: 'muted' }, el('span', { text: about }), ...(c.same_purpose ? [' ', el('span', { class: 'badge', text: 'та же цель' })] : [])),
    el('div', { class: 'row gap' },
      ...c.files.map((f) => el('button', { type: 'button', class: 'secondary', 'data-similar-file': f.id, onclick: () => open(f) },
        `Открыть заключение (${f.type}, ${size(f.size_bytes)})`)),
      el('a', { href: `#order=${c.id}`, class: 'link' }, 'Открыть дело')));
}

async function open(f) {
  try {
    const { url } = await api('GET', `/api/documents/${f.id}/link`);
    location.assign(url);
  } catch (err) { say($('similar-msg'), err.message); }
}
