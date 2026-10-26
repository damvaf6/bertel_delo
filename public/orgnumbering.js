// «Нумерация отчётов организации» у руководителя (2.415): один образец и общий счёт за год для всех экспертов организации —
// следующий номер и после чьего, сколько выдано в этом году; подсказка — самый частый свой образец экспертов.
import { api, el, say } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
let org = null;
let guess = null;

$('org-numbering-guess').addEventListener('click', () => {
  if (guess) $('org-numbering-pattern').value = guess;
  $('org-numbering-pattern').focus();
});
$('org-numbering-save').addEventListener('click', async () => {
  const value = $('org-numbering-pattern').value;
  try {
    await api('PUT', `/api/orgs/${org.id}/numbering`, { pattern: value });
  } catch (err) { say($('org-numbering-msg'), err.message); return; }
  await load();
  say($('org-numbering-msg'), value.trim() ? 'Образец сохранён — номера всем экспертам организации выдаются по нему' : 'Общий счёт выключен — эксперты нумеруют по своим образцам', 'ok');
});

export async function loadOrgNumbering(o) {
  org = o;
  say($('org-numbering-msg'), '');
  await load();
}

async function load() {
  let numbering;
  try {
    ({ numbering } = await api('GET', `/api/orgs/${org.id}/numbering`));
  } catch (err) { say($('org-numbering-msg'), err.message); return; }
  $('org-numbering-box').classList.remove('hidden');
  $('org-numbering-pattern').value = numbering.pattern ?? '';
  guess = numbering.guess;
  $('org-numbering-guess').textContent = guess ? `Взять образец экспертов: ${guess}` : '';
  $('org-numbering-guess').classList.toggle('hidden', !guess);
  const own = numbering.experts.filter((e) => e.pattern);
  $('org-numbering-experts').textContent = !numbering.staff
    ? 'От организации пока не работает ни один эксперт.'
    : own.length
      ? `Свои образцы экспертов: ${own.map((e) => `${e.name} — ${e.pattern}`).join('; ')}.${numbering.pattern ? ' Пока у организации есть образец, они не действуют.' : ''}`
      : 'Своих образцов у экспертов нет.';
  const n = numbering.next;
  const box = $('org-numbering-next');
  if (!n) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('strong', { 'data-org-numbering-next': n.number, text: `${numbering.pattern ? 'Следующий номер' : 'Следующий номер по этому образцу'}: № ${n.number}` }),
    el('span', { class: 'muted', text: n.after
      ? ` — после № ${n.after.number} (${dayRu(n.after.on)}${n.after.expert_name ? `, ${n.after.expert_name}` : ''})${numbering.issued ? `; выдано по счёту организации в ${numbering.year} году — ${numbering.issued}` : ''}`
      : ` — в ${numbering.year} году номеров по образцу ещё не было` }),
  );
}
