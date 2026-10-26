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

// 2.404: чего не нашлось — почему (файла нет, скан или нет в тексте), где это обычно пишут и переход к файлу в деле.
const GAP_SAY = {
  none: (m) => `Файла отчёта в деле нет: ${m} — допишите в таблице`,
  unread: (m) => `Файл отчёта не читается (скан или картинка): ${m} — допишите в таблице`,
  text: (m) => `Не нашлось в файле отчёта: ${m} — допишите в таблице`,
};
function gapsOf(r) {
  return [
    el('div', { class: 'overdue', 'data-registry-missing': r.id, text: (GAP_SAY[r.files] ?? GAP_SAY.text)(r.missing.join(', ')) }),
    ...(r.where.length ? [el('div', { class: 'muted', 'data-registry-where': r.id }, ...r.where.map((w) => el('div', { text: `Обычно ${w}` })))] : []),
    el('button', { type: 'button', class: 'secondary', 'data-registry-open': r.id,
      onclick: () => { location.hash = `order=${r.id}&to=result`; } }, r.files === 'none' ? 'Открыть дело' : 'Открыть файл отчёта в деле'),
  ];
}

// Прогон 2.410: номер повторяется в перечне — у каждого отчёта свой (в ИИ-проверке дела — 2.403).
const dupLine = (r) => el('div', { class: 'overdue', 'data-registry-dup': r.id,
  text: `Номер № ${r.number} повторяется в перечне — у каждого отчёта свой номер, проверьте файл отчёта` });

let seq = 0;
$('registry-year').addEventListener('change', () => loadRegistry(true));
$('registry-quarter').addEventListener('change', () => loadRegistry(true));
$('registry-csv').addEventListener('click', () => location.assign(`/api/specialist/me/registry?format=csv&${period()}`));
// 2.407: сданные за период заключения одним архивом — файлы с подписями и опись.
$('registry-archive').addEventListener('click', () => location.assign(`/api/specialist/me/registry/archive?${period()}`));

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
  const dups = registry.rows.filter((r) => r.dup).length;
  $('registry-total').textContent = n ? `${registry.name}: ${n} ${plural(n, 'отчёт', 'отчёта', 'отчётов')}${gaps ? ` · дописать — в ${gaps}` : ''}`
    + (dups ? ` · номер повторяется — в ${dups}` : '')
    + (n > registry.shown ? ` · показаны первые ${registry.shown}, выберите квартал` : '') : '';
  $('registry-rows').replaceChildren(...registry.rows.map((r, i) => el('li', { 'data-registry': r.id },
    el('a', { class: 'title', href: `#order=${r.id}`, text: `${i + 1}. ${r.number ? `Отчёт № ${r.number}` : 'Отчёт без номера'}${r.made_on ? ` от ${dayRu(r.made_on)}` : ''}` }),
    el('div', { text: r.object }),
    el('div', { class: 'muted', text: [r.service_name, r.purpose, r.customer ? `заказчик — ${r.customer}` : null].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: `${r.value_rub != null ? `${r.value_name}: ${rub(r.value_rub * 100)}` : 'стоимость не найдена'} · сдано ${dayRu(r.done_on)}` }),
    ...(r.dup ? [dupLine(r)] : []),
    ...(r.missing.length ? gapsOf(r) : []))));
  $('registry-empty').classList.toggle('hidden', registry.rows.length > 0);
  $('registry-archive').textContent = `Заключения архивом (${registry.shown})`;
  $('registry-archive').classList.toggle('hidden', registry.rows.length === 0);
}
