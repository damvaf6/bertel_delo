import { api, say, formatPhone } from '/common.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');
const RESEND_SEC = 60; // как на сервере: новый код не чаще раза в минуту
let phone = '';
let timer = null;

api('GET', '/api/health').then((h) => {
  if (h?.test_data) $('test-mark').classList.remove('hidden');
  if (h?.demo) showDemo();
}).catch(() => {});

// Демо-площадка (решение Дамира 05.10.2026): вместо входа по телефону — кнопки «Войти как …» за вымышленных людей.
async function showDemo() {
  $('test-mark').textContent = 'Демо-площадка · всё вымышленное · данные сбрасываются каждую ночь';
  $('login-box').classList.add('hidden');
  $('demo-box').classList.remove('hidden');
  const { roles } = await api('GET', '/api/demo/roles');
  $('demo-roles').replaceChildren(...roles.map((r) => {
    const b = document.createElement('button');
    b.className = 'secondary wide';
    b.dataset.as = r.as;
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = r.title;
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = r.hint;
    b.append(t, hint);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('POST', '/api/demo/login', { as: r.as });
        location.replace(target);
      } catch (err) {
        say($('demo-msg'), err.message);
        b.disabled = false;
      }
    });
    const li = document.createElement('li');
    li.append(b);
    return li;
  }));
}
// Куда после входа: раздел кабинета, с которого пришли (витрина, ссылка из уведомления), — только свои разделы.
const next = new URLSearchParams(location.search).get('next') || '';
const target = `/kabinet${/^#[a-z]+(=[0-9a-f-]{36})?$/i.test(next) ? next : ''}`;
// Уже вошли — сразу в кабинет.
api('GET', '/api/me').then(() => location.replace(target)).catch(() => {});

// Звонок с кодом можно заказать через минуту после предыдущего кода (СМС или звонка).
// Остаток считается по часам, а не по числу срабатываний таймера: в фоне телефон таймеры придерживает.
function startCallTimer(label) {
  clearInterval(timer);
  const deadline = Date.now() + RESEND_SEC * 1000;
  const btn = $('call');
  btn.disabled = true;
  btn.textContent = label;
  const tick = () => {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      $('call-hint').textContent = '';
      return;
    }
    $('call-hint').textContent = `Не пришёл код? Звонок можно заказать через ${left} с.`;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function codeSent(channel) {
  const to = formatPhone(phone.replace(/\D/g, ''));
  $('code-hint').textContent = channel === 'call'
    ? `Сейчас на ${to} позвонит робот и назовёт код. Код действует 5 минут.`
    : `Код отправлен на ${to}. Действует 5 минут.`;
  $('code-label').textContent = channel === 'call' ? 'Код из звонка' : 'Код из СМС';
  startCallTimer(channel === 'call' ? 'Позвонить ещё раз' : 'Позвонить с кодом');
}

$('phone-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  say(msg, '');
  $('get-code').disabled = true;
  try {
    phone = $('phone').value;
    await api('POST', '/api/auth/code', { phone });
    codeSent('sms');
    $('phone-form').classList.add('hidden');
    $('code-form').classList.remove('hidden');
    $('code').focus();
  } catch (err) {
    say(msg, err.message);
  } finally {
    $('get-code').disabled = false;
  }
});

$('call').addEventListener('click', async () => {
  say(msg, '');
  $('call').disabled = true;
  try {
    await api('POST', '/api/auth/code', { phone, channel: 'call' });
    codeSent('call');
    $('code').value = '';
    $('code').focus();
  } catch (err) {
    say(msg, err.message);
    $('call').disabled = false;
  }
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  say(msg, '');
  $('sign-in').disabled = true;
  try {
    await api('POST', '/api/auth/verify', { phone, code: $('code').value.trim() });
    location.replace(target);
  } catch (err) {
    say(msg, err.message);
    $('sign-in').disabled = false;
  }
});

$('change-phone').addEventListener('click', () => {
  clearInterval(timer);
  $('code-form').classList.add('hidden');
  $('phone-form').classList.remove('hidden');
  $('code').value = '';
  say(msg, '');
});
