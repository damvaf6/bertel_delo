// Дистанционный осмотр в деле (задача 2.3): исполнитель выдаёт владельцу объекта ссылку и видит присланные фото по шагам —
// со временем и геометкой; остальные, кто видит заявку, — только фото. Тексты — через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const STATE_RU = { active: 'действует', finished: 'владелец нажал «Готово»', revoked: 'отозвана', expired: 'срок истёк', closed: 'закрыта' };
let ctx = null;   // { order }

export async function loadInspection(current) {
  const box = $('inspect-box');
  say($('inspect-msg'), '');
  $('inspect-fresh').classList.add('hidden');
  if (!current.order.module) { box.classList.add('hidden'); return; }
  ctx = { order: current.order };
  const r = await api('GET', `/api/orders/${current.order.id}/inspection`);
  const photos = r.steps.reduce((n, s) => n + s.photos.length, 0);
  box.classList.toggle('hidden', !(r.can_issue || r.links.length || photos));
  if (box.classList.contains('hidden')) return;
  $('inspect-days').replaceChildren(...r.days.map((d) => el('option', { value: String(d), text: d === 1 ? '1 день' : d < 5 ? `${d} дня` : `${d} дней` })));
  $('inspect-days').value = r.days.includes(3) ? '3' : String(r.days[0]);
  $('inspect-issue').classList.toggle('hidden', !r.can_issue);
  $('inspect-state').textContent = photos
    ? `Фото осмотра: ${photos}. У каждого — время и место съёмки; «без геометки» — владелец не разрешил определять место.`
    : r.can_issue ? 'Владелец объекта снимает его сам по ссылке — без входа, по шагам для этого вида объекта. Фото появятся здесь.'
      : 'Фото осмотра пока нет.';
  renderLinks(r);
  renderSteps(r, photos);
}

function renderLinks(r) {
  $('inspect-links').replaceChildren(...r.links.map((l) => el('li', { class: 'doc', 'data-link': l.id },
    el('div', {},
      el('div', { class: 'name', text: `Ссылка от ${timeRu(l.created_at)} — ${STATE_RU[l.state]}` }),
      el('div', { class: 'muted', text: `${l.state === 'active' ? `действует до ${timeRu(l.expires_at)} · ` : ''}фото: ${l.photos}` })),
    ...(r.can_issue && l.state === 'active' ? [el('button', { class: 'danger', 'data-action': 'revoke', onclick: () => revoke(l) }, 'Отозвать')] : []))));
}

function photoLine(p) {
  const parts = [`получено ${timeRu(p.received_at)}`];
  if (p.shot_at) parts.push(`снято ${timeRu(p.shot_at)}`);
  if (p.geo) parts.push(`место ${p.geo.lat.toFixed(5)}, ${p.geo.lon.toFixed(5)}${p.geo.accuracy_m !== null ? ` (±${p.geo.accuracy_m} м)` : ''}`);
  return parts.join(' · ');
}

function renderSteps(r, photos) {
  $('inspect-steps').classList.toggle('hidden', !photos);
  if (!photos) { $('inspect-steps').replaceChildren(); return; }
  $('inspect-steps').replaceChildren(...r.steps.map((s) => el('li', { 'data-step': s.id },
    el('div', { class: 'doc' },
      el('span', { class: 'title', text: s.title }),
      el('span', { class: `badge${s.photos.length ? ' ok' : ''}`, text: s.photos.length ? `фото: ${s.photos.length}` : s.optional ? 'если есть' : 'нет фото' })),
    ...s.photos.map((p) => el('div', { class: 'doc' },
      el('div', {},
        el('div', { class: 'name', text: p.filename }),
        el('div', { class: 'photo-meta', text: photoLine(p) }),
        ...(p.geo ? [] : [el('div', { class: 'photo-meta warn', text: 'без геометки' })])),
      el('button', { class: 'secondary', 'data-action': 'open-photo', onclick: () => open(p) }, 'Открыть'))))));
}

async function open(p) {
  try {
    const { url } = await api('GET', `/api/documents/${p.document_id}/link`);
    location.assign(url);
  } catch (err) { say($('inspect-msg'), err.message); }
}

async function revoke(l) {
  if (!confirm('Отозвать ссылку? Владелец больше не сможет присылать по ней фото; присланные останутся в деле.')) return;
  try {
    await api('DELETE', `/api/orders/${ctx.order.id}/inspection/${l.id}`);
    await loadInspection({ order: ctx.order });
    say($('inspect-msg'), 'Ссылка отозвана', 'ok');
  } catch (err) { say($('inspect-msg'), err.message); }
}

$('inspect-issue').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('inspect-new').disabled = true;
  try {
    const r = await api('POST', `/api/orders/${ctx.order.id}/inspection`, { days: Number($('inspect-days').value) });
    await loadInspection({ order: ctx.order });
    $('inspect-url').textContent = location.origin + r.path;
    $('inspect-fresh').classList.remove('hidden');
    say($('inspect-msg'), 'Ссылка готова — отправьте её владельцу объекта', 'ok');
  } catch (err) { say($('inspect-msg'), err.message); } finally { $('inspect-new').disabled = false; }
});

$('inspect-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('inspect-url').textContent);
    say($('inspect-msg'), 'Ссылка скопирована', 'ok');
  } catch { say($('inspect-msg'), 'Не удалось скопировать — выделите ссылку и скопируйте вручную'); }
});
