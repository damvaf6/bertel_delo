// Служебный помощник приложения «БЕРТЕЛ Дело» на телефоне (задача штаба: приложение с экрана «Домой»).
// Хранит на телефоне только сами страницы, стили и скрипты — чтобы кабинет и осмотр открывались при слабой связи.
// Ответы ядра (/api/…) — заявки, документы, фото, данные людей — не хранит и не трогает: они всегда идут на сервер.
// Страница и скрипт — сначала из сети (всегда свежая версия); сеть не ответила вовремя — из сохранённого на телефоне.
const VERSION = 'delo-v2';
const CORE = ['/offline.html', '/app.css', '/theme.js', '/common.js', '/pwa.js', '/drafts.js', '/osmotr', '/osmotr.js', '/manifest.webmanifest', '/icon-192.png'];
const PAGE_WAIT_MS = 5000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Что можно хранить: свой адрес, GET, не ядро, ответ целиком и без запрета хранения.
const keepable = (req, url) => req.method === 'GET' && url.origin === self.location.origin && !url.pathname.startsWith('/api/');
const storable = (res) => res && res.ok && res.type === 'basic' && !/no-store/.test(res.headers.get('cache-control') || '');

// Адрес без «?…»: /osmotr?visit=… и /osmotr — одна и та же страница.
const keyOf = (url) => url.origin + url.pathname;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (!keepable(req, url)) return;
  e.respondWith(fromNetwork(req, url));
});

async function fromNetwork(req, url) {
  const cache = await caches.open(VERSION);
  const net = fetch(req).then((res) => {
    if (storable(res)) cache.put(keyOf(url), res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {}); // сеть ответила позже копии или не ответила — ошибка уже обработана ниже
  const saved = await cache.match(keyOf(url));
  // Сохранённой копии нет — ждём сеть сколько нужно; есть — не дольше PAGE_WAIT_MS, дальше копия, а сеть обновит её.
  try {
    if (!saved) return await net;
    return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('медленно')), PAGE_WAIT_MS))]);
  } catch {
    if (saved) return saved;
    if (req.mode === 'navigate') return (await cache.match(keyOf(new URL('/offline.html', url)))) || Response.error();
    return Response.error();
  }
}
