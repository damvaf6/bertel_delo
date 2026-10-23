// Дистанционный осмотр в деле (задача 2.3): исполнитель выдаёт владельцу объекта ссылку и видит присланные фото по шагам —
// со временем и геометкой; остальные, кто видит заявку, — только фото. Тексты — через textContent.
// Задача 2.20: ссылку платформа может отправить владельцу СМС; эксперт просит переснять шаг — владелец видит просьбу у шага.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const STATE_RU = { active: 'действует', finished: 'владелец нажал «Готово»', revoked: 'отозвана', expired: 'срок истёк', closed: 'закрыта' };
let ctx = null;   // { order, silent }

export async function loadInspection(current) {
  const box = $('inspect-box');
  say($('inspect-msg'), '');
  $('inspect-fresh').classList.add('hidden');
  if (!current.order.module) { box.classList.add('hidden'); return; }
  ctx = { order: current.order };
  // Почерковедческая (2.81): по ссылке снимают документ, а не объект; товароведческая (2.82) — товар.
  const subject = current.order.subject;
  $('inspect-head').textContent = subject === 'document' ? 'Съёмка документа по ссылке' : subject === 'goods' ? 'Осмотр товара по ссылке' : subject === 'car' ? 'Осмотр автомобиля по ссылке' : 'Дистанционный осмотр';
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
  setNext({ inspect: { photos, missing: photos ? missing.length : 0, issued: r.links.some((l) => l.state === 'active') } });
  if (missing.length) $('retake-step').value = missing[0].id;
  $('inspect-state').textContent = photos
    ? `Фото осмотра: ${photos}. У каждого — время и место съёмки; «без геометки» — владелец не разрешил определять место.`
      + (missing.length && !(r.incomplete && r.can_issue) ? ` Не снято: ${missing.map((s) => s.title).join(', ')} — попросите доснять ниже.` : '')
    : r.can_issue ? (subject === 'goods' ? 'Тот, у кого товар, снимает его сам по ссылке — без входа, по шагам: товар целиком, маркировка, недостаток крупно. Фото появятся здесь.'
      : subject === 'car' ? 'Владелец снимает машину сам по ссылке — без входа, по шагам: с четырёх сторон, VIN, пробег, каждое повреждение крупно. Фото появятся здесь.'
      : 'Владелец объекта снимает его сам по ссылке — без входа, по шагам для этого вида объекта. Фото появятся здесь.')
      : 'Фото осмотра пока нет.';
  renderSilent(r);
  renderExpiring(r);
  renderIncomplete(r);
  renderLinks(r);
  renderSteps(r, photos);
}

// Ссылка молчит 2 дня (2.85): владелец не прислал ни одного фото. «Отправить ссылку снова» выдаёт новую (прежняя отзывается;
// секрет прежней не хранится) — с тем сроком и телефоном, что в форме ниже; номер для СМС мы не храним — вписать снова.
function renderSilent(r) {
  const s = r.silent;
  ctx.silent = s;
  askedPhone = false;
  $('inspect-silent').classList.toggle('hidden', !(s && r.can_issue));
  if (!s || !r.can_issue) return;
  $('inspect-silent-text').textContent = `${s.expired ? 'Срок ссылки истёк, а' : 'Уже 2 дня'} владелец не прислал ни одного фото (ссылка от ${timeRu(s.since)}${s.sms_to ? `, СМС на ${s.sms_to}` : ''}). `
    + 'Отправьте ссылку снова — новая заменит прежнюю. Чтобы ушла СМС, впишите телефон ниже: номер мы не храним.';
}

// Ссылка перестанет действовать в ближайшие сутки, «Готово» не нажато (2.196): «Продлить ссылку» — на срок из формы ниже
// (по умолчанию 3 дня), считая от прежнего срока; владелец снимает по той же ссылке.
function renderExpiring(r) {
  const x = r.expiring;
  ctx.expiring = x;
  $('inspect-expiring').classList.toggle('hidden', !(x && r.can_issue));
  if (!x || !r.can_issue) return;
  $('inspect-expiring-text').textContent = `Ссылка действует до ${timeRu(x.expires_at)}, а владелец ещё не нажал «Готово»`
    + ` (${x.photos ? `фото по ссылке: ${x.photos}` : 'фото пока нет'}). Продлите — владелец доснимет по той же ссылке, отправлять заново не нужно.`;
  const d = Number($('inspect-days').value);
  $('inspect-extend').textContent = `Продлить на ${d === 1 ? '1 день' : d < 5 ? `${d} дня` : `${d} дней`}`;
}
$('inspect-days').addEventListener('change', () => { if (ctx?.expiring) renderExpiring({ expiring: ctx.expiring, can_issue: true }); });
$('inspect-extend').addEventListener('click', async () => {
  const btn = $('inspect-extend');
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/orders/${ctx.order.id}/inspection/extend`, { link_id: ctx.expiring.link_id, days: Number($('inspect-days').value) });
    await loadInspection({ order: ctx.order });
    say($('inspect-msg'), `Ссылка продлена до ${timeRu(r.expires_at)} — владелец снимает по той же ссылке`, 'ok');
  } catch (err) { say($('inspect-msg'), err.message); } finally { btn.disabled = false; }
});

// Владелец нажал «Готово», а обязательные шаги без фото (2.208): «Попросить доснять» ставит у каждого такого шага просьбу и
// выдаёт новую ссылку (по закрытой владелец уже не снимет) — с тем сроком и телефоном, что в форме ниже; СМС скажет «переснять».
const ASK_MISSING = 'Этот шаг не снят — снимите, пожалуйста';
function renderIncomplete(r) {
  const x = r.incomplete;
  ctx.incomplete = x;
  askedMissingPhone = false;
  $('inspect-incomplete').classList.toggle('hidden', !(x && r.can_issue));
  if (!x || !r.can_issue) return;
  $('inspect-incomplete-text').textContent = `Владелец нажал «Готово» ${timeRu(x.finished_at)} (фото по ссылке: ${x.photos}), но не снял: `
    + `${x.missing.map((s) => s.title).join(', ')}. По этой ссылке он больше снимать не может — попросите доснять: у шагов появится просьба,`
    + ' владельцу уйдёт новая ссылка. Чтобы ушла СМС, впишите телефон ниже: номер мы не храним.';
  // Своя подсказка владельцу к каждому шагу (2.227): он увидит её у шага; пусто — общая просьба «снимите, пожалуйста».
  const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  $('inspect-missing-notes').replaceChildren(...x.missing.map((m) => {
    const id = `missing-note-${m.id}`;
    const own = byId[m.id]?.retake?.note;
    return el('div', { class: 'field', 'data-missing-step': m.id },
      el('label', { for: id, text: `${m.title} — подсказка владельцу` }),
      el('input', { id, type: 'text', maxlength: String(r.note_max), value: own && own !== ASK_MISSING ? own : '',
        placeholder: `Необязательно. Например: ${MISSING_EXAMPLE[m.id] ?? 'крупно, при дневном свете'}` }));
  }));
}
// Примеры в поле — чтобы было понятно, что писать; сам текст эксперт пишет свой.
const MISSING_EXAMPLE = {
  meters: 'счётчики — крупно, чтобы читались цифры', rooms: 'каждую комнату из двух углов', door: 'дверь вместе с номером квартиры',
  facade: 'дом целиком, чтобы был виден номер', car_vin: 'VIN крупно, чтобы читались все знаки', car_odometer: 'пробег при включённом зажигании',
};
let askedMissingPhone = false;
$('inspect-ask-missing').addEventListener('click', async () => {
  if (!$('inspect-phone').value.trim() && !askedMissingPhone) {
    askedMissingPhone = true;
    $('inspect-phone').focus();
    say($('inspect-msg'), 'Впишите телефон владельца — пришлём СМС. Без телефона нажмите ещё раз: ссылку скопируете и отправите сами');
    return;
  }
  const btn = $('inspect-ask-missing');
  btn.disabled = true;
  try {
    // Просьба уже стоит у шага, а поле пусто — её текст не трогаем; вписал подсказку — она заменяет прежнюю.
    const open = await api('GET', `/api/orders/${ctx.order.id}/inspection`);
    for (const s of open.steps.filter((st) => ctx.incomplete.missing.some((m) => m.id === st.id))) {
      const own = $(`missing-note-${s.id}`)?.value.trim() ?? '';
      const note = own || (s.retake ? null : ASK_MISSING);
      if (note && note !== s.retake?.note) await api('POST', `/api/orders/${ctx.order.id}/inspection/retakes`, { step: s.id, note });
    }
    $('inspect-issue').requestSubmit();
  } catch (err) { say($('inspect-msg'), err.message); } finally { btn.disabled = false; }
});

// Прежняя ушла СМС, а телефон не вписан — сначала просим вписать; второе нажатие — ссылка без СМС (скопировать и отправить самому).
let askedPhone = false;
$('inspect-resend').addEventListener('click', () => {
  if (ctx.silent?.sms_to && !$('inspect-phone').value.trim() && !askedPhone) {
    askedPhone = true;
    $('inspect-phone').focus();
    say($('inspect-msg'), 'Впишите телефон владельца — пришлём СМС. Без телефона нажмите ещё раз: ссылку скопируете и отправите сами');
    return;
  }
  askedPhone = false;
  $('inspect-issue').requestSubmit();
});

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
  // 2.379: как в подписи под фото в Word — кто снимал.
  parts.push(p.visit_id ? 'снял помощник на выезде' : 'снял владелец по ссылке');
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
    ...(s.reshot ? [reshotBox(s.reshot)] : []),
    ...stepPhotos(s.photos))));
}

// Доснято по подсказке (2.237): что просили, новое фото и прежнее рядом — сравнить, стало ли лучше. Прежнего не было — так и
// написано. Нажал картинку — фото целиком.
function reshotBox(rs) {
  const pic = (label, p) => {
    const btn = el('button', { class: 'secondary', 'data-action': 'open-photo', onclick: () => open(p) }, `Фото ${p.no}`);
    if (p.thumb) btn.classList.add('hidden');
    return el('div', { class: 'reshot-pic' },
      el('div', { class: 'photo-meta', text: `${label} — Фото ${p.no}` }),
      ...(p.thumb ? [thumbImg(p, () => btn.classList.remove('hidden'))] : []),
      btn);
  };
  return el('div', { class: 'reshot', 'data-reshot': '' },
    // Общая фраза «Этот шаг не снят…» (своей подсказки не было) — просто «по Вашей просьбе».
    el('div', { class: 'photo-meta ok', text: rs.note === ASK_MISSING ? 'Доснято по Вашей просьбе' : `Доснято по Вашей подсказке: ${rs.note}` }),
    rs.before
      ? el('div', { class: 'reshot-compare' }, pic('Было', rs.before), pic('Стало', rs.after))
      : el('div', { class: 'photo-meta', text: `Раньше этот шаг не снимали — новое: Фото ${rs.after.no}` }));
}

// Фото шага: «Фото N» — тот же номер, что в отчёте Word (2.96). До трёх — сразу, больше — свёрнуто (2.49: при 100 фото страница дела уходила на десятки экранов).
// Картинки — сразу и без «Открыть» у каждого (2.183): нажал картинку — фото целиком. Больше трёх — первые шесть картинок
// полосой над свёрнутым списком. «Открыть» остаётся только у снимка без картинки или если картинка не загрузилась.
const PHOTOS_OPEN = 3;
const STRIP = 6;
function stepPhotos(photos) {
  const row = (p) => {
    const btn = el('button', { class: 'secondary', 'data-action': 'open-photo', onclick: () => open(p) }, 'Открыть');
    if (p.thumb) btn.classList.add('hidden');
    return el('div', { class: 'doc' },
      ...(p.thumb ? [thumbImg(p, () => btn.classList.remove('hidden'))] : []),
      el('div', { class: 'photo-text' },
        el('div', { class: 'name', text: `Фото ${p.no} · ${p.filename}` }),
        el('div', { class: 'photo-meta', text: photoLine(p) }),
        ...(p.geo ? [] : [el('div', { class: 'photo-meta warn', text: 'без геометки' })])),
      btn);
  };
  if (photos.length <= PHOTOS_OPEN) return photos.map(row);
  const noGeo = photos.filter((p) => !p.geo).length;
  const withThumb = photos.filter((p) => p.thumb);
  const strip = withThumb.slice(0, STRIP);
  const more = photos.length - strip.length;
  return [
    ...(strip.length ? [el('div', { class: 'photo-strip', 'data-action': 'photo-strip' },
      ...strip.map((p) => thumbImg(p)),
      ...(more ? [el('span', { class: 'photo-more muted', text: `ещё ${more}` })] : []))] : []),
    el('details', { class: 'step-photos' },
      el('summary', { text: `${strip.length ? 'Все фото шага' : 'Показать фото'}: ${photos.length}${noGeo ? ` (без геометки: ${noGeo})` : ''}` }),
      ...photos.map(row))];
}

// Картинка снимка (2.71): грузится, когда видна на экране; нажал — фото целиком. Не загрузилась — убирается, onFail
// показывает «Открыть».
function thumbImg(p, onFail) {
  const img = el('img', { class: 'photo-thumb', src: `/api/documents/${p.document_id}/thumb`, alt: `Фото ${p.no}`, title: `Фото ${p.no} — открыть целиком`,
    loading: 'lazy', width: '96', height: '72', role: 'button', tabindex: '0', 'data-action': 'photo-thumb', onclick: () => open(p) });
  img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p); } });
  img.addEventListener('error', () => { img.remove(); onFail?.(); });
  return img;
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
