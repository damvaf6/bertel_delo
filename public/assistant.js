// Раздел «Помощник» (задача 1.8): вход через проблему (ИИ разъясняет и предлагает услугу, заявка — черновиком) и ассистент
// по делам с раздельной памятью: личной и по каждой организации. Тексты — только через textContent.
import { api, el, say } from '/common.js';
import { state, show } from '/shell.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let consultation = null;
let scope = '';

export async function showAssistant() {
  show('assistant-view', 'assistant');
  say($('problem-msg'), '');
  say($('as-msg'), '');
  await loadAssistant();
}

// ——— Вход через проблему ———

$('problem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('problem-text').value.trim();
  if (!text) return say($('problem-msg'), 'Опишите, что случилось');
  $('problem-send').disabled = true;
  say($('problem-msg'), 'Помощник разбирается…', 'ok');
  try {
    ({ consultation } = await api('POST', '/api/ai/problem', { text }));
    say($('problem-msg'), '');
    renderAnswer();
  } catch (err) { say($('problem-msg'), err.message); } finally { $('problem-send').disabled = false; }
});

function renderAnswer() {
  const c = consultation;
  $('problem-answer').classList.remove('hidden');
  $('pa-explanation').textContent = c.explanation;
  $('pa-steps').replaceChildren(...c.self_steps.map((s) => el('li', { text: s })));
  $('pa-steps-title').classList.toggle('hidden', c.self_steps.length === 0);
  $('pa-specialist').textContent = c.specialist
    ? `${c.specialist}${c.service ? ` — услуга «${c.service.name}» есть на платформе.` : '.'}`
    : 'Подходящей услуги на платформе помощник не нашёл. Если всё же нужна оценка или экспертиза — выберите услугу сами.';
  const options = state.catalog.modules.flatMap((m) => m.services.map((s) => el('option', { value: `${m.id}/${s.id}`, text: `${m.name} · ${s.name}` })));
  $('pa-service').replaceChildren(el('option', { value: '', text: 'Выберите услугу' }), ...options);
  $('pa-service').value = c.service ? `${c.service.module}/${c.service.service}` : '';
  $('pa-org').replaceChildren(el('option', { value: '', text: 'Лично от себя' }),
    ...state.me.orgs.map((o) => el('option', { value: o.org_id, text: `От организации «${o.name}»` })));
  $('pa-org-box').classList.toggle('hidden', state.me.orgs.length === 0);
  $('pa-disclaimer').textContent = c.disclaimer;
  $('pa-order').disabled = !!c.order_id;
  say($('pa-msg'), '');
  $('problem-answer').scrollIntoView({ block: 'start' });
}

$('pa-order').addEventListener('click', async () => {
  const service = $('pa-service').value;
  if (!service) return say($('pa-msg'), 'Выберите услугу');
  $('pa-order').disabled = true;
  try {
    const { order_id: orderId } = await api('POST', `/api/ai/consultations/${consultation.id}/order`, { service, org_id: $('pa-org').value || null });
    consultation.order_id = orderId;
    location.hash = `order=${orderId}`;
  } catch (err) { say($('pa-msg'), err.message); $('pa-order').disabled = false; }
});

// ——— Ассистент ———

async function loadAssistant() {
  const q = scope ? `?org=${scope}` : '';
  let a;
  try { a = await api('GET', `/api/assistant${q}`); } catch (err) {
    if (err.status !== 404 || !scope) throw err;
    scope = ''; // из организации ушли — возвращаемся в личную память
    a = await api('GET', '/api/assistant');
  }
  $('as-scope').replaceChildren(...a.scopes.map((s) => el('option', { value: s.org_id || '', text: s.name })));
  $('as-scope').value = scope;
  $('as-scope-box').classList.toggle('hidden', a.scopes.length < 2);
  $('as-order').replaceChildren(el('option', { value: '', text: 'Без заявки' }), ...a.orders.map((o) => el('option', { value: o.id, text: o.title })));
  $('as-messages').replaceChildren(...a.messages.map((m) => el('li', { class: m.role === 'user' ? 'mine' : 'assistant' },
    el('div', { class: 'who', text: `${m.role === 'user' ? 'Вы' : 'Ассистент'} · ${timeRu(m.at)}` }),
    el('div', { class: 'body', text: m.body }))));
  $('as-empty').classList.toggle('hidden', a.messages.length > 0);
  $('as-hidden').textContent = a.hidden ? `Скрыто сообщений: ${a.hidden} — о заявках, к которым у Вас больше нет доступа.` : '';
  $('as-hidden').classList.toggle('hidden', !a.hidden);
  $('as-clear').disabled = a.messages.length === 0;
}

$('as-scope').addEventListener('change', async () => {
  scope = $('as-scope').value;
  say($('as-msg'), '');
  await loadAssistant();
});

$('as-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('as-text').value.trim();
  if (!text) return say($('as-msg'), 'Напишите вопрос');
  $('as-send').disabled = true;
  say($('as-msg'), 'Ассистент думает…', 'ok');
  try {
    await api('POST', '/api/assistant', { text, org_id: scope || null, order_id: $('as-order').value || null });
    $('as-text').value = '';
    say($('as-msg'), '');
    const keep = $('as-order').value;
    await loadAssistant();
    $('as-order').value = keep;
  } catch (err) { say($('as-msg'), err.message); } finally { $('as-send').disabled = false; }
});

$('as-clear').addEventListener('click', async () => {
  if (!window.confirm('Очистить память ассистента в этом разделе? Разговор будет удалён.')) return;
  try {
    await api('DELETE', `/api/assistant${scope ? `?org=${scope}` : ''}`);
    await loadAssistant();
    say($('as-msg'), 'Память очищена', 'ok');
  } catch (err) { say($('as-msg'), err.message); }
});
