// Приложение с экрана «Домой» (задача штаба 3f817197): описание приложения, значки, служебный помощник для слабой связи.
// Помощник хранит на телефоне только страницы, стили и скрипты; ответы ядра (/api/…) с данными людей — никогда.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('описание приложения: название, запуск в кабинете, отдельное окно, значки 192 и 512 есть', async () => {
  const r = await fetch(`${S.base}/manifest.webmanifest`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.name, 'БЕРТЕЛ Дело');
  assert.equal(m.short_name, 'Дело');
  assert.equal(m.start_url, '/kabinet');
  assert.equal(m.display, 'standalone');
  assert.equal(m.lang, 'ru');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'значки для установки на Android');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'значок для круглой и квадратной формы');
  for (const src of [...new Set(m.icons.map((i) => i.src)), '/apple-touch-icon.png']) {
    const ic = await fetch(S.base + src);
    assert.equal(ic.status, 200, src);
    assert.equal(ic.headers.get('content-type'), 'image/png', src);
    const head = Buffer.from(await ic.arrayBuffer()).subarray(0, 24);
    assert.equal(head.subarray(1, 4).toString(), 'PNG', src);
    const w = head.readUInt32BE(16);
    const h = head.readUInt32BE(20);
    assert.equal(w, h, `${src}: квадратный`);
    if (src !== '/apple-touch-icon.png') assert.ok(m.icons.some((i) => i.src === src && i.sizes === `${w}x${h}`), `${src}: размер как в описании`);
    else assert.equal(w, 180, 'значок для iPhone — 180×180');
  }
  // Запуск с экрана «Домой» открывает кабинет.
  assert.equal((await fetch(S.base + m.start_url)).status, 200);
});

test('страницы ссылаются на описание приложения и значок iPhone; осмотр — без описания (у владельца нет кабинета)', async () => {
  for (const p of ['/', '/kabinet', '/ekspertiza']) {
    const html = await (await fetch(S.base + p)).text();
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, p);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/, p);
    assert.match(html, /<meta name="theme-color" content="#1d4ed8">/, p);
  }
  const osmotr = await (await fetch(`${S.base}/osmotr`)).text();
  assert.doesNotMatch(osmotr, /rel="manifest"/);
  const off = await fetch(`${S.base}/offline.html`);
  assert.equal(off.status, 200);
  assert.match(await off.text(), /Нет связи с интернетом/);
});

test('служебный помощник: отдаётся с корня, не трогает ответы ядра и чужие адреса, хранит страницу «нет связи»', async () => {
  const r = await fetch(`${S.base}/sw.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  const code = await r.text();
  assert.match(code, /!url\.pathname\.startsWith\('\/api\/'\)/, 'ответы ядра не хранятся');
  assert.match(code, /req\.method === 'GET'/, 'хранятся только чтения');
  assert.match(code, /url\.origin === self\.location\.origin/, 'только свой адрес');
  assert.match(code, /no-store/, 'запрет хранения соблюдается');
  // Всё, что помощник кладёт на телефон при установке, существует.
  const core = JSON.parse(code.match(/const CORE = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const p of core) assert.equal((await fetch(S.base + p)).status, 200, p);
  // Ответы ядра по-прежнему запрещено хранить где-либо.
  assert.equal((await fetch(`${S.base}/api/health`)).headers.get('cache-control'), 'no-store');
});

test('дизайн-система v2: все страницы с темой, цвета только переменными, тёмная тема и «меньше движения» в стиле', async () => {
  for (const p of ['/', '/kabinet', '/ekspertiza', '/osmotr', '/offline.html', '/proverka.html', '/dopusk.html']) {
    const html = await (await fetch(S.base + p)).text();
    assert.match(html, /<script src="\/theme\.js"><\/script>\n<\/head>|<script src="\/theme\.js"><\/script>/, `${p}: тема ставится в <head>`);
    assert.ok(html.indexOf('/theme.js') < html.indexOf('</head>'), `${p}: до показа страницы`);
  }
  const css = await (await fetch(`${S.base}/app.css`)).text();
  const themes = css.slice(0, css.indexOf('color-scheme: dark;\n}') + 21);
  const rest = css.slice(themes.length);
  assert.deepEqual(rest.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'цвета вне переменных');
  assert.match(themes, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\)/, 'по настройке телефона');
  assert.match(themes, /:root\[data-theme="dark"\] \{/, 'по кнопке');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  const js = await (await fetch(`${S.base}/theme.js`)).text();
  assert.match(js, /localStorage/);
  const sw = await (await fetch(`${S.base}/sw.js`)).text();
  assert.match(sw, /'\/theme\.js'/, 'тема есть и без связи');
});
