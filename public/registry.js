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
// 2.438: к сданному отчёту пришли замечания — в перечне новая редакция (номер, дата, стоимость — из неё), прежняя — в деле.
const editionLine = (r) => el('div', { class: 'muted', 'data-registry-edition': r.id,
  text: r.edition.pending
    ? `Пришли замечания от ${dayRu(r.edition.remarks_on)} — ответ готовится${r.edition.due ? ` (ответить до ${dayRu(r.edition.due)})` : ''}; в перечне — сданная редакция`
    : `Новая редакция от ${dayRu(r.edition.on)} — после замечаний от ${dayRu(r.edition.remarks_on)}; прежняя остаётся в деле и в архиве` });
const dupLine = (r) => el('div', { class: 'overdue', 'data-registry-dup': r.id,
  text: `Номер № ${r.number} повторяется в перечне — у каждого отчёта свой номер, проверьте файл отчёта` });

// 2.416: пропуски в нумерации за год — «№ 12 нет — дело отменено?»; что знает платформа — почему и к какому делу.
export const HOLE_SAY = {
  cancelled: (h) => `№ ${h.number} нет — дело «${h.title}» отменено после выдачи номера`,
  // 2.418: эксперт выбрал, что с номером отменённого дела.
  kept: (h) => `№ ${h.number} нет — дело «${h.title}» отменено, номер оставлен пропуском`,
  freed: (h) => `№ ${h.number} нет — дело «${h.title}» отменено, номер освобождён: его получит следующее дело`,
  open: (h) => `№ ${h.number} выдан делу «${h.title}» — оно ещё не сдано`,
  file: (h) => `№ ${h.number} выдан делу «${h.title}», а в файле отчёта другой номер`,
  unknown: (h) => `№ ${h.number} нет — дело отменено или номер пропущен?`,
};
export function holesBox(box, holes, { year, link }) {
  const items = holes?.list ?? [];
  const lines = [];
  if (holes?.org) lines.push(el('p', { class: 'muted', 'data-holes-org': '1', text: `Номера выдаёт организация «${holes.org}» — пропуски в общем счёте видит руководитель` }));
  else if (holes?.total) {
    lines.push(el('p', { class: 'overdue', 'data-holes-total': String(holes.total),
      text: `Пропуски в нумерации за ${year} год: ${holes.total} (с № ${holes.from} по № ${holes.to})` }));
    lines.push(el('ul', { class: 'list' }, ...items.map((h) => el('li', { 'data-hole': String(h.seq) },
      link && h.order_id ? el('a', { href: link(h), text: HOLE_SAY[h.reason](h) }) : el('span', { text: HOLE_SAY[h.reason](h) }),
      ...(h.expert_name ? [el('div', { class: 'muted', text: `эксперт ${h.expert_name}` })] : [])))));
    if (holes.total > items.length) lines.push(el('p', { class: 'muted', text: `и ещё ${holes.total - items.length}` }));
  } else if (holes?.from) lines.push(el('p', { class: 'muted', 'data-holes-none': '1', text: `Пропусков в нумерации нет: с № ${holes.from} по № ${holes.to}` }));
  if (holes?.guessed && holes.from) lines.push(el('p', { class: 'muted', text: `Образец номера не задан — считаем по образцу ${holes.pattern} из последнего отчёта; задайте свой в «Нумерации отчётов»` }));
  box.replaceChildren(...lines);
  box.classList.toggle('hidden', !lines.length);
}

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
  holesBox($('registry-holes'), registry.holes, { year: registry.year, link: (h) => `#order=${h.order_id}` });
  $('registry-rows').replaceChildren(...registry.rows.map((r, i) => el('li', { 'data-registry': r.id },
    el('a', { class: 'title', href: `#order=${r.id}`, text: `${i + 1}. ${r.number ? `Отчёт № ${r.number}` : 'Отчёт без номера'}${r.made_on ? ` от ${dayRu(r.made_on)}` : ''}` }),
    el('div', { text: r.object }),
    el('div', { class: 'muted', text: [r.service_name, r.purpose, r.customer ? `заказчик — ${r.customer}` : null].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: `${r.value_rub != null ? `${r.value_name}: ${rub(r.value_rub * 100)}` : 'стоимость не найдена'} · сдано ${dayRu(r.done_on)}` }),
    ...(r.edition ? [editionLine(r)] : []),
    ...(r.dup ? [dupLine(r)] : []),
    ...(r.missing.length ? gapsOf(r) : []))));
  $('registry-empty').classList.toggle('hidden', registry.rows.length > 0);
  $('registry-archive').textContent = `Заключения архивом (${registry.shown})`;
  $('registry-archive').classList.toggle('hidden', registry.rows.length === 0);
  $('registry-archive-note').classList.toggle('hidden', registry.rows.length === 0);
}
