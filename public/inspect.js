// Дистанционный осмотр в деле (задача 2.3): исполнитель выдаёт владельцу объекта ссылку и видит присланные фото по шагам —
// со временем и геометкой; остальные, кто видит заявку, — только фото. Тексты — через textContent.
// Задача 2.20: ссылку платформа может отправить владельцу СМС; эксперт просит переснять шаг — владелец видит просьбу у шага.
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
  $('inspect-retake').classList.toggle('hidden', !(r.can_issue && photos));
  $('retake-step').replaceChildren(...r.steps.map((s) => el('option', { value: s.id, text: s.title })));
  $('retake-note').maxLength = r.note_max;
  // Чего не хватает (2.33): владелец мог нажать «Готово», не сняв обязательные шаги, — видно сразу, без пролистывания.
  const missing = r.steps.filter((s) => !s.optional && !s.photos.length);
  if (missing.length) $('retake-step').value = missing[0].id;
  $('inspect-state').textContent = photos
    ? `Фото осмотра: ${photos}. У каждого — время и место съёмки; «без геометки» — владелец не разрешил определять место.`
      + (missing.length ? ` Не снято: ${missing.map((s) => s.title).join(', ')} — попросите доснять ниже.` : '')
    : r.can_issue ? 'Владелец объекта снимает его сам по ссылке — без входа, по шагам для этого вида объекта. Фото появятся здесь.'
      : 'Фото осмотра пока нет.';
  renderLinks(r);
  renderSteps(r, photos);
}

function renderLinks(r) {
  $('inspect-links').replaceChildren(...r.links.map((l) => el('li', { class: 'doc', 'data-link': l.id },
    el('div', {},
      el('div', { class: 'name', text: `Ссылка от ${timeRu(l.created_at)} — ${STATE_RU[l.state]}` }),
      el('div', { class: 'muted', text: `${l.state === 'active' ? `действует до ${timeRu(l.expires_at)} · ` : ''}фото: ${l.photos}${l.sms_to ? ` · СМС на ${l.sms_to}` : ''}` })),
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
      el('span', { class: `badge${s.photos.length && !s.retake ? ' ok' : ''}`, text: s.retake ? 'переснять' : s.photos.length ? `фото: ${s.photos.length}` : s.optional ? 'если есть' : 'нет фото' })),
    ...(s.retake ? [el('div', { class: 'doc retake' },
      el('div', { class: 'photo-meta warn', text: `Попросили переснять: ${s.retake.note}` }),
      ...(r.can_issue ? [el('button', { class: 'secondary', 'data-action': 'retake-cancel', onclick: () => cancelRetake(s.retake) }, 'Отменить')] : []))] : []),
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

async function cancelRetake(rt) {
  try {
    await api('DELETE', `/api/orders/${ctx.order.id}/inspection/retakes/${rt.id}`);
    await loadInspection({ order: ctx.order });
    say($('inspect-msg'), 'Просьба отменена', 'ok');
  } catch (err) { say($('inspect-msg'), err.message); }
}

$('inspect-retake').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('retake-send').disabled = true;
  try {
    const r = await api('POST', `/api/orders/${ctx.order.id}/inspection/retakes`, { step: $('retake-step').value, note: $('retake-note').value });
    $('retake-note').value = '';
    await loadInspection({ order: ctx.order });
    say($('inspect-msg'), r.active_link
      ? 'Просьба записана — владелец увидит её, открыв ссылку снова'
      : 'Просьба записана. Выдайте владельцу новую ссылку (можно СМС) — он увидит, что переснять', 'ok');
  } catch (err) { say($('inspect-msg'), err.message); } finally { $('retake-send').disabled = false; }
});

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
    const phone = $('inspect-phone').value.trim();
    const r = await api('POST', `/api/orders/${ctx.order.id}/inspection`, { days: Number($('inspect-days').value), ...(phone ? { phone } : {}) });
    $('inspect-phone').value = '';
    await loadInspection({ order: ctx.order });
    $('inspect-url').textContent = location.origin + r.path;
    $('inspect-fresh').classList.remove('hidden');
    if (r.sms === 'sent') say($('inspect-msg'), `Ссылка отправлена СМС на ${r.link.sms_to}`, 'ok');
    else if (r.sms === 'failed') say($('inspect-msg'), 'СМС не отправилось — скопируйте ссылку и отправьте владельцу сами');
    else say($('inspect-msg'), 'Ссылка готова — отправьте её владельцу объекта', 'ok');
  } catch (err) { say($('inspect-msg'), err.message); } finally { $('inspect-new').disabled = false; }
});

$('inspect-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('inspect-url').textContent);
    say($('inspect-msg'), 'Ссылка скопирована', 'ok');
  } catch { say($('inspect-msg'), 'Не удалось скопировать — выделите ссылку и скопируйте вручную'); }
});
