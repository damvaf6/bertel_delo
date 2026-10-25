// «Перечень отчётов для СРО» в профиле специалиста (2.401): свои сданные отчёты об оценке за год или квартал — номер, дата
// составления, объект, цель, итоговая стоимость; чего не нашлось в файле отчёта — «дописать». Таблица для Excel — с сервера.
import { api, el, say } from '/common.js';
import { rub } from '/money.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const period = () => `year=${encodeURIComponent($('registry-year').value)}&quarter=${encodeURIComponent($('registry-quarter').value)}`;
const plural = (n, one, few, many) => {
  const t = Math.abs(n) % 100; const u = t % 10;
  return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
};

let seq = 0;
$('registry-year').addEventListener('change', () => loadRegistry(true));
$('registry-quarter').addEventListener('change', () => loadRegistry(true));
$('registry-csv').addEventListener('click', () => location.assign(`/api/specialist/me/registry?format=csv&${period()}`));

export async function loadRegistry(chosen = false) {
  const my = ++seq;
  let registry;
  try {
    ({ registry } = await api('GET', `/api/specialist/me/registry${chosen ? `?${period()}` : ''}`));
  } catch (err) { say($('registry-msg'), err.message); return; }
  if (my !== seq) return;
  say($('registry-msg'), '');
  const sel = $('registry-year');
  sel.replaceChildren(...registry.years.map((y) => el('option', { value: String(y), text: String(y) })));
  sel.value = String(registry.year);
  $('registry-quarter').value = registry.quarter ? String(registry.quarter) : '';
  const n = registry.total;
  const gaps = registry.rows.filter((r) => r.missing.length).length;
  $('registry-total').textContent = n ? `${registry.name}: ${n} ${plural(n, 'отчёт', 'отчёта', 'отчётов')}${gaps ? ` · дописать — в ${gaps}` : ''}`
    + (n > registry.shown ? ` · показаны первые ${registry.shown}, выберите квартал` : '') : '';
  $('registry-rows').replaceChildren(...registry.rows.map((r, i) => el('li', { 'data-registry': r.id },
    el('a', { class: 'title', href: `#order=${r.id}`, text: `${i + 1}. ${r.number ? `Отчёт № ${r.number}` : 'Отчёт без номера'}${r.made_on ? ` от ${dayRu(r.made_on)}` : ''}` }),
    el('div', { text: r.object }),
    el('div', { class: 'muted', text: [r.service_name, r.purpose, r.customer ? `заказчик — ${r.customer}` : null].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: `${r.value_rub != null ? `${r.value_name}: ${rub(r.value_rub * 100)}` : 'стоимость не найдена'} · сдано ${dayRu(r.done_on)}` }),
    ...(r.missing.length ? [el('div', { class: 'overdue', 'data-registry-missing': r.id, text: `Не нашлось в файле отчёта: ${r.missing.join(', ')} — допишите в таблице` })] : []))));
  $('registry-empty').classList.toggle('hidden', registry.rows.length > 0);
}
