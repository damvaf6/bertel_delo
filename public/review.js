// Отзыв заказчика (2.467, схема 5 экранов — решение Дамира 31.10/02.11.2026, экран 5): после выдачи результата — оценка 1–5
// и пара слов. Заказчику — форма или его отзыв; диспетчеру — отзыв или «пока не оставил». Эксперту — позже (по схеме).
// Тексты — через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const NAMES = ['', 'Плохо', 'Есть недочёты', 'Нормально', 'Хорошо', 'Отлично'];
const dayRu = (iso) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
export const starsText = (n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;
let ctx = null; // { order, review, reload, rating }

function paintStars() {
  for (const b of $('rate-stars').children) b.setAttribute('aria-pressed', String(Number(b.dataset.n) <= ctx.rating));
  $('rate-stars-name').textContent = ctx.rating ? `${ctx.rating} из 5 — ${NAMES[ctx.rating]}` : 'Нажмите на звезду';
}

$('rate-stars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
  const b = el('button', { type: 'button', 'data-n': String(n), 'aria-pressed': 'false', 'aria-label': `${n} из 5`, text: '★' });
  b.addEventListener('click', () => { if (ctx) { ctx.rating = n; paintStars(); say($('rate-msg'), ''); } });
  return b;
}));

export function renderReview(current, reload) {
  const r = current.review ?? null;
  const keep = ctx && ctx.order.id === current.order.id ? ctx.rating : 0;
  ctx = { order: current.order, review: r, reload, rating: keep };
  $('rate-box').classList.toggle('hidden', !r);
  if (!r) return;
  const staff = !r.mine;
  $('rate-box').querySelector('h2').textContent = staff ? 'Отзыв заказчика' : 'Ваш отзыв';
  $('rate-form').classList.toggle('hidden', !r.can_review);
  $('rate-done').classList.toggle('hidden', r.can_review);
  if (r.can_review) {
    paintStars();
    return;
  }
  $('rate-done-stars').textContent = r.rating ? `${starsText(r.rating)}  ${r.rating} из 5` : '';
  $('rate-done-stars').classList.toggle('hidden', !r.rating);
  $('rate-done-text').textContent = !r.rating ? 'Заказчик пока не оставил отзыв.'
    : [r.text ? `«${r.text}»` : 'Без текста.', r.at ? `${staff ? 'Оставлен' : 'Вы оставили отзыв'} ${dayRu(r.at)}.` : null].filter(Boolean).join(' ');
}

$('rate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!ctx) return;
  if (!ctx.rating) return say($('rate-msg'), 'Поставьте оценку — нажмите на звезду');
  const btn = $('rate-send');
  btn.disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/review`, { rating: ctx.rating, text: $('rate-text').value });
    $('rate-text').value = '';
    ctx.rating = 0;
    await ctx.reload();
    say($('rate-msg'), 'Спасибо! Отзыв сохранён', 'ok');
  } catch (err) {
    say($('rate-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});
