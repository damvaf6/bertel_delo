// «Перечень отчётов для СРО» у руководителя организации (2.402): сданные отчёты об оценке всех экспертов организации за год
// или квартал — по каждому эксперту сколько и в скольких дописать, ниже все отчёты с именем эксперта. Таблица для Excel —
// с сервера, столбец «Оценщик». Экспертов от организации нет — карточки нет, как у сводки за месяц. Номер отчёта ведёт к делу
// в «Делах экспертов» (там завершённые — за 90 дней).
import { api, el, say } from '/common.js';
import { rub } from '/money.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const period = () => `year=${encodeURIComponent($('org-registry-year').value)}&quarter=${encodeURIComponent($('org-registry-quarter').value)}`;
const plural = (n, one, few, many) => {
  const t = Math.abs(n) % 100; const u = t % 10;
  return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
};
const reports = (n) => `${n} ${plural(n, 'отчёт', 'отчёта', 'отчётов')}`;

let org = null;
let seq = 0;
$('org-registry-year').addEventListener('change', () => load(true));
$('org-registry-quarter').addEventListener('change', () => load(true));
$('org-registry-csv').addEventListener('click', () => location.assign(`/api/orgs/${org.id}/registry?format=csv&${period()}`));

export async function loadOrgRegistry(o) {
  org = o;
  say($('org-registry-msg'), '');
  await load(false);
}

async function load(chosen) {
  const my = ++seq;
  let registry;
  try {
    ({ registry } = await api('GET', `/api/orgs/${org.id}/registry${chosen ? `?${period()}` : ''}`));
  } catch (err) { say($('org-registry-msg'), err.message); return; }
  if (my !== seq) return;
  $('org-registry-box').classList.toggle('hidden', !registry.staff);
  const sel = $('org-registry-year');
  sel.replaceChildren(...registry.years.map((y) => el('option', { value: String(y), text: String(y) })));
  sel.value = String(registry.year);
  $('org-registry-quarter').value = registry.quarter ? String(registry.quarter) : '';
  const n = registry.total;
  const gaps = registry.rows.filter((r) => r.missing.length).length;
  $('org-registry-total').textContent = n ? `${registry.name}: ${reports(n)}${gaps ? ` · дописать — в ${gaps}` : ''}`
    + (n > registry.shown ? ` · показаны первые ${registry.shown}, выберите квартал` : '') : '';
  $('org-registry-experts').replaceChildren(...registry.experts.map((e) => el('li', { 'data-registry-expert': e.id },
    el('strong', { text: e.name }),
    el('div', { class: e.gaps ? 'overdue' : 'muted', text: `${reports(e.n)}${e.gaps ? ` · дописать — в ${e.gaps}` : ' · всё нашлось в файлах'}` }))));
  $('org-registry-rows').replaceChildren(...registry.rows.map((r, i) => el('li', { 'data-org-registry': r.id },
    el('a', { class: 'title', href: `#org=${org.id}&case=${r.id.slice(0, 8).toUpperCase()}&to=case`, text: `${i + 1}. ${r.number ? `Отчёт № ${r.number}` : 'Отчёт без номера'}${r.made_on ? ` от ${dayRu(r.made_on)}` : ''}` }),
    el('div', { text: `${r.expert_name} · ${r.object}` }),
    el('div', { class: 'muted', text: [r.service_name, r.purpose, r.customer ? `заказчик — ${r.customer}` : null].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: `${r.value_rub != null ? `${r.value_name}: ${rub(r.value_rub * 100)}` : 'стоимость не найдена'} · сдано ${dayRu(r.done_on)}` }),
    ...(r.missing.length ? [el('div', { class: 'overdue', text: `Не нашлось в файле отчёта: ${r.missing.join(', ')} — допишите в таблице` })] : []))));
  $('org-registry-empty').classList.toggle('hidden', registry.rows.length > 0);
}
