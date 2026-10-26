// «Нумерация отчётов» в профиле специалиста (2.411): образец своего номера отчёта, подсказка образца по последнему отчёту
// и следующий свободный номер этого года.
import { api, el, say } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
let guess = null;

$('numbering-guess').addEventListener('click', () => {
  if (guess) $('numbering-pattern').value = guess;
  $('numbering-pattern').focus();
});
$('numbering-save').addEventListener('click', async () => {
  try {
    await api('PATCH', '/api/specialist/me', { report_pattern: $('numbering-pattern').value });
  } catch (err) { say($('numbering-msg'), err.message); return; }
  await loadNumbering();
  say($('numbering-msg'), $('numbering-pattern').value ? 'Образец сохранён' : 'Нумерация выключена', 'ok');
});

const lastLine = (l) => `Последний номер в файлах отчётов этого года: № ${l.number} (${dayRu(l.on)}${l.title ? `, «${l.title}»` : ''})`;

export async function loadNumbering() {
  let numbering;
  try {
    ({ numbering } = await api('GET', '/api/specialist/me/numbering'));
  } catch (err) { say($('numbering-msg'), err.message); return; }
  say($('numbering-msg'), '');
  $('numbering-pattern').value = numbering.pattern ?? '';
  // Работает от организации с образцом (2.415) — номера выдаёт организация из общего счёта; свой образец не действует.
  const org = numbering.org;
  $('numbering-org').classList.toggle('hidden', !org);
  $('numbering-org').textContent = org ? `Номера отчётов выдаёт организация «${org.name}» по образцу ${org.pattern} — общий счёт для всех её экспертов. Свой образец не действует, пока Вы работаете от неё.` : '';
  for (const id of ['numbering-own', 'numbering-save']) $(id).classList.toggle('hidden', !!org);
  guess = numbering.guess;
  $('numbering-last').textContent = numbering.last ? lastLine(numbering.last) : `В файлах отчётов ${numbering.year} года номеров пока нет.`;
  $('numbering-guess').textContent = guess ? `Взять образец по последнему отчёту: ${guess}` : '';
  $('numbering-guess').classList.toggle('hidden', !guess);
  // Номер выдаётся делу при сборке Word (2.412) — только когда образец сохранён.
  $('numbering-word').classList.toggle('hidden', !numbering.pattern && !org);
  const n = numbering.next;
  const box = $('numbering-next');
  if (!n) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('strong', { 'data-numbering-next': n.number, text: `${numbering.pattern || org ? 'Следующий номер' : 'Следующий номер по этому образцу'}: № ${n.number}` }),
    el('span', { class: 'muted', text: n.after
      ? ` — после № ${n.after.number}${org && !n.after.mine ? ' (дело другого эксперта организации)' : ''}${n.matched > 1 ? `, по образцу в этом году — ${n.matched}` : ''}`
      : ' — в этом году отчётов с номером по образцу ещё не было' }),
  );
}
