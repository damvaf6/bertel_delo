// Проверка юриста перед соглашением (задача штаба 40217197-…-81f7) — раздел «Проверить юриста» (решение Дамира 24.10.2026:
// заказчикам; пока юристы вымышленные — только администратору): ФИО → совпадения из реестра адвокатов → карточка (реестр,
// дела в судах — о чём и чем закончилось, без участников) → «Подтвердить» / «Оспорить» у карточки и у каждого дела;
// оспорить — с пояснением.
import { api, el, say } from '/common.js';
import { state, show } from '/shell.js';

const $ = (id) => document.getElementById(id);
const dateRu = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const timeRu = (s) => `${new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} МСК`;
const STATUS_BADGE = { active: 'ok', suspended: 'warn', ended: 'warn' };

let current = null; // { reg_no, full_name }

export function showLawyers() {
  show('lawyers-view', null);
  $('lawyer-admin-only').classList.toggle('hidden', !state.lawyers?.admin_only);
}

$('lawyer-find').addEventListener('submit', async (e) => {
  e.preventDefault();
  say($('lawyer-msg'), '');
  $('lawyer-card').classList.add('hidden');
  $('lawyer-found').replaceChildren();
  const name = $('lawyer-name').value.trim();
  if (name.length < 3) { say($('lawyer-msg'), 'Введите фамилию, имя и отчество юриста'); $('lawyer-name').focus(); return; }
  try {
    const r = await api('GET', `/api/lawyer-check?name=${encodeURIComponent(name)}`);
    if (!r.lawyers.length) { say($('lawyer-msg'), r.note, 'ok'); return; }
    if (r.lawyers.length > 1) say($('lawyer-msg'), `Нашлось ${r.lawyers.length}: выберите нужного по региону и номеру в реестре`, 'ok');
    $('lawyer-found').replaceChildren(...r.lawyers.map((l) => el('li', { 'data-lawyer': l.reg_no },
      el('button', { class: 'open', onclick: () => openCard(l) },
        el('div', { class: 'title', text: l.full_name }),
        el('div', { class: 'muted', text: `${l.region} · реестр № ${l.reg_no}${l.fictional ? ' · вымышленный, для проверки' : ''}` })))));
    if (r.lawyers.length === 1) openCard(r.lawyers[0]);
  } catch (err) { say($('lawyer-msg'), err.message); }
});

async function openCard(l) {
  current = { reg_no: l.reg_no, full_name: l.full_name };
  try {
    const r = await api('GET', `/api/lawyer-check/card?reg=${encodeURIComponent(l.reg_no)}&name=${encodeURIComponent(l.full_name)}`);
    render(r.card, r.marks);
  } catch (err) { say($('lawyer-msg'), err.message); }
}

function render(c, marks) {
  const reg = c.registry;
  const facts = [['Номер в реестре', c.reg_no], ['Регион', reg.region], ['Палата', reg.chamber],
    ['Форма адвокатского образования', reg.formation], ['Статус адвоката с', reg.since ? dateRu(reg.since) : null]].filter(([, v]) => v);
  const box = $('lawyer-card');
  box.replaceChildren(
    el('h3', { text: c.full_name }),
    ...(c.fictional ? [el('p', { class: 'muted', text: 'Вымышленный юрист — только для проверки страницы.' })] : []),
    el('h4', { text: reg.title }),
    el('p', {}, el('span', { class: `badge ${STATUS_BADGE[reg.status] ?? ''}`, 'data-lawyer-status': reg.status, text: reg.status_name })),
    el('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    markRow(null, marks),
    el('h4', { text: `Дела в судах${c.cases.length ? ` — ${c.cases.length}` : ''}` }),
    el('p', { class: 'muted', text: c.cases_note }),
    ...(c.outcome_note ? [el('p', { class: 'muted', id: 'lawyer-outcome-note', text: c.outcome_note })] : []),
    el('ul', { class: 'list', id: 'lawyer-cases' }, ...c.cases.map((k) => el('li', { 'data-case': k.key },
      el('div', { class: 'title', text: `${k.kind_name} № ${k.number}` }),
      el('div', { class: 'muted', text: `${k.court} · ${dateRu(k.date)}` }),
      el('div', { text: k.subject ?? 'О чём дело — разобрать не удалось, откройте решение по ссылке.' }),
      el('div', { 'data-outcome': '' }, el('b', { text: k.outcome ?? 'Исход в решении не указан' }),
        ...(k.side ? [el('span', { class: 'muted', text: ` · юрист — представитель ${k.side}` })] : [])),
      el('a', { href: k.url, target: '_blank', rel: 'noopener noreferrer', text: 'Решение на сайте' }),
      markRow(k.key, marks)))),
    el('p', { class: 'muted', text: c.sources_note }),
    marksList(marks, c.cases));
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'start' });
}

// Кнопки «Подтвердить» / «Оспорить»; «Оспорить» раскрывает поле пояснения.
function markRow(caseKey, marks) {
  const mine = marks.filter((m) => m.mine && m.case_key === caseKey)[0];
  const msg = el('p', { class: 'msg', role: 'status' });
  const note = el('textarea', { rows: '2', maxlength: '500', 'aria-label': 'Что в сведениях не так' });
  const form = el('div', { class: 'hidden' }, note,
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'danger', text: 'Отправить', onclick: () => send('dispute', note.value) })));
  async function send(kind, text) {
    if (kind === 'dispute' && !text.trim()) { say(msg, 'Напишите, что не так: например, «дело не этого юриста»'); note.focus(); return; }
    try {
      const r = await api('POST', '/api/lawyer-check/marks', { reg: current.reg_no, name: current.full_name, kind, ...(caseKey ? { case: caseKey } : {}), ...(text ? { note: text.trim() } : {}) });
      await openCard(current);
      say($('lawyer-msg'), kind === 'confirm' ? 'Отмечено: сведения верны' : 'Отправлено: сведения оспорены', 'ok');
      return r;
    } catch (err) { say(msg, err.message); }
  }
  return el('div', { class: 'lawyer-mark', 'data-mark': caseKey ?? 'card' },
    ...(mine ? [el('div', { class: 'muted', text: mine.kind === 'confirm' ? 'Вы подтвердили' : 'Вы оспорили' })] : []),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', text: 'Подтвердить', onclick: () => send('confirm', '') }),
      el('button', { type: 'button', class: 'secondary', text: 'Оспорить', onclick: () => { form.classList.remove('hidden'); note.focus(); } })),
    form, msg);
}

function marksList(marks, cases) {
  if (!marks.length) return el('p', { class: 'muted', text: 'Отметок «подтверждаю» и «оспариваю» пока нет.' });
  const caseName = (key) => cases.find((k) => k.key === key)?.number;
  return el('details', { id: 'lawyer-marks' }, el('summary', { text: `Отметки — ${marks.length}` }),
    el('ul', { class: 'list' }, ...marks.map((m) => el('li', {},
      el('div', { class: 'title', text: `${m.kind === 'confirm' ? 'Подтверждено' : 'Оспорено'}${m.case_key ? ` — дело № ${caseName(m.case_key) ?? m.case_key}` : ' — карточка'}` }),
      el('div', { class: 'muted', text: `${timeRu(m.at)}${m.by ? ` · ${m.by}` : ''}` }),
      ...(m.note ? [el('div', { text: m.note })] : [])))));
}
