// Витрина «Дело: Экспертиза» (2.53): пометка проверочной версии; вошедшему — «В кабинет» вместо «Войти».
import { api } from '/common.js';
import { SITE_LATER, SITE_PRICES, priceText } from '/site-prices.js';

const $ = (id) => document.getElementById(id);
api('GET', '/api/health').then((h) => {
  if (h?.test_data) $('test-mark').classList.remove('hidden');
  if (h?.demo) $('test-mark').textContent = 'Демо-площадка · всё вымышленное · данные сбрасываются каждую ночь';
}).catch(() => {});
api('GET', '/api/me').then(() => { $('top-enter').textContent = 'В кабинет'; }).catch(() => {});

// Цены «от … ₽» у услуг — из одного места (public/site-prices.js, решение Дамира 02.11.2026).
for (const li of document.querySelectorAll('#what li[data-price]')) {
  const rub = SITE_PRICES[li.dataset.price];
  if (rub) li.querySelector('.price').textContent = `— ${priceText(rub)}`;
  // Вид «позже» (2.462) — пометка «скоро».
  if (SITE_LATER.includes(li.dataset.price)) {
    const mark = document.createElement('span');
    mark.className = 'later';
    mark.textContent = 'скоро';
    li.append(' ', mark);
  }
}
