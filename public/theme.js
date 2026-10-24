// Тема экранов «Дела» (дизайн-система v2): светлая или тёмная. По умолчанию — как в настройке телефона;
// кнопка в шапке (на компьютере — сбоку) запоминает выбор на этом устройстве. Обычный скрипт в <head> —
// тема ставится до показа страницы, без вспышки светлого фона.
(function () {
  var KEY = 'delo-theme';
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);

  function dark() {
    var t = root.getAttribute('data-theme');
    if (t) return t === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function paint(btn) {
    var d = dark();
    btn.setAttribute('aria-pressed', d ? 'true' : 'false');
    btn.setAttribute('aria-label', d ? 'Светлая тема' : 'Тёмная тема');
    btn.title = d ? 'Включить светлую тему' : 'Включить тёмную тему';
    btn.textContent = d ? '☀' : '☾';
  }

  function mount() {
    var top = document.querySelector('header.top');
    if (!top || document.getElementById('theme-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'theme-toggle';
    btn.className = 'theme-toggle';
    paint(btn);
    btn.addEventListener('click', function () {
      var next = dark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* выбор не запомнится — тема всё равно сменится */ }
      paint(btn);
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var follow = function () { if (!root.getAttribute('data-theme')) paint(btn); };
      if (mq.addEventListener) mq.addEventListener('change', follow);
    }
    var brand = top.querySelector('.brand');
    top.insertBefore(btn, brand ? brand.nextSibling : top.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
