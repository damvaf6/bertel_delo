// «Дело» как приложение на телефоне (задача штаба: приложение с экрана «Домой»): значок на экране «Домой», окно без
// адресной строки, страницы открываются при слабой связи (sw.js). Кнопка «Установить»: на Android — окно установки
// браузера; на iPhone и там, где браузер окна не даёт, — короткая подсказка, где нажать. Уже установлено — кнопки нет.
import { say } from '/common.js';

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const LATER = 'delo.install.later';
let offer = null;           // окно установки, которое браузер разрешил показать (Android, Chrome и похожие)
const wired = [];

export const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const HELP_IPHONE = 'На iPhone: внизу экрана нажмите «Поделиться» (квадрат со стрелкой вверх), затем «На экран „Домой“» и «Добавить».';
export const HELP_OTHER = 'Откройте меню браузера (три точки справа вверху) и выберите «Установить приложение» или «Добавить на главный экран».';

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e; });
window.addEventListener('appinstalled', () => {
  offer = null;
  for (const w of wired) { w.box.classList.add('hidden'); }
});

// box — карточка, button — «Установить», help — подсказка, later — «Не сейчас» (запоминается на этом телефоне).
export function wireInstall({ box, button, help, later }) {
  if (!box || installed()) return;
  if (later && remembered()) return;
  wired.push({ box });
  box.classList.remove('hidden');
  button.addEventListener('click', async () => {
    if (offer) {
      const shown = offer;
      offer = null;
      try {
        await shown.prompt();
        const { outcome } = await shown.userChoice;
        if (outcome === 'accepted') { say(help, 'Готово: значок «Дело» — на экране телефона.', 'ok'); help.classList.remove('hidden'); return; }
      } catch { /* окно не показалось — ниже подсказка */ }
    }
    say(help, iphone() ? HELP_IPHONE : HELP_OTHER, 'ok');
    help.classList.remove('hidden');
  });
  later?.addEventListener('click', () => {
    try { localStorage.setItem(LATER, '1'); } catch { /* хранилище недоступно — карточка вернётся при следующем входе */ }
    box.classList.add('hidden');
  });
}

function remembered() {
  try { return localStorage.getItem(LATER) === '1'; } catch { return false; }
}
