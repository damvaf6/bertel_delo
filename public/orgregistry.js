// «Перечень отчётов для СРО» у руководителя организации (2.402): сданные отчёты об оценке всех экспертов организации за год
// или квартал — по каждому эксперту сколько и в скольких дописать, ниже все отчёты с именем эксперта. Таблица для Excel —
// с сервера, столбец «Оценщик». Экспертов от организации нет — карточки нет, как у сводки за месяц. Номер отчёта ведёт к делу
// в «Делах экспертов» (там завершённые — за 90 дней); более старое — без ссылки, файлы — в архиве сводки (прогон 2.410).
import { api, el, say } from '/common.js';
import { rub } from '/money.js';
import { dayRu } from '/order.js';
import { holesBox } from '/registry.js';

const $ = (id) => document.getElementById(id);
const period = () => `year=${encodeURIComponent($('org-registry-year').value)}&quarter=${encodeURIComponent($('org-registry-quarter').value)}`;
const dupLine = (r) => el('div', { class: 'overdue', 'data-registry-dup': r.id,
  text: `Номер № ${r.number} повторяется в отчётах эксперта ${r.expert_name} — у каждого отчёта оценщика свой номер` });
const OLD_CASE = 'Сдано больше 90 дней назад — в «Делах экспертов» его уже нет; файлы отчёта — в «Заключениях архивом» сводки за тот месяц';
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
  const dups = registry.rows.filter((r) => r.dup).length;
  $('org-registry-total').textContent = n ? `${registry.name}: ${reports(n)}${gaps ? ` · дописать — в ${gaps}` : ''}`
    + (dups ? ` · номер повторяется — в ${dups}` : '')
    + (n > registry.shown ? ` · показаны первые ${registry.shown}, выберите квартал` : '') : '';
  // 2.416: пропуски в общем счёте организации за год (образец организации задан), у номера — эксперт.
  holesBox($('org-registry-holes'), registry.holes, { year: registry.year });
  $('org-registry-experts').replaceChildren(...registry.experts.map((e) => el('li', { 'data-registry-expert': e.id },
    el('strong', { text: e.name }),
    el('div', { class: e.gaps || e.dups ? 'overdue' : 'muted', text: `${reports(e.n)}${e.gaps ? ` · дописать — в ${e.gaps}` : ' · всё нашлось в файлах'}`
      + (e.dups ? ` · номер повторяется — в ${e.dups}` : '') }))));
  $('org-registry-rows').replaceChildren(...registry.rows.map((r, i) => el('li', { 'data-org-registry': r.id },
    el(r.in_cases === false ? 'strong' : 'a', { class: 'title', ...(r.in_cases === false ? {} : { href: `#org=${org.id}&case=${r.id.slice(0, 8).toUpperCase()}&to=case` }),
      text: `${i + 1}. ${r.number ? `Отчёт № ${r.number}` : 'Отчёт без номера'}${r.made_on ? ` от ${dayRu(r.made_on)}` : ''}` }),
    el('div', { text: `${r.expert_name} · ${r.object}` }),
    el('div', { class: 'muted', text: [r.service_name, r.purpose, r.customer ? `заказчик — ${r.customer}` : null].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: `${r.value_rub != null ? `${r.value_name}: ${rub(r.value_rub * 100)}` : 'стоимость не найдена'} · сдано ${dayRu(r.done_on)}` }),
    ...(r.in_cases === false ? [el('div', { class: 'muted', 'data-registry-old': r.id, text: OLD_CASE })] : []),
    ...(r.dup ? [dupLine(r)] : []),
    ...(r.missing.length ? [el('div', { class: 'overdue', text: `Не нашлось в файле отчёта: ${r.missing.join(', ')} — допишите в таблице` })] : []))));
  $('org-registry-empty').classList.toggle('hidden', registry.rows.length > 0);
}
