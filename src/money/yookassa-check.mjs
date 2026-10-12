// ЮKassa — проверка перед подключением (задача 2а.10, задача штаба 3f417197-…-ae86): публичный адрес HTTPS для
// уведомлений, адрес возврата, ключи магазина, контакт покупателя для чека, реквизиты для модерации и список частых ошибок.
// Только чтение настроек; «проверить адрес» — один запрос сервера к своему же адресу уведомлений извне.
// Требования ЮKassa к HTTP-уведомлениям: https, порт 443 или 8443, действующий сертификат (не самоподписанный), ответ 200 —
// иначе ЮKassa повторяет уведомление сутки. Состоянию из уведомления ядро не верит (money-ops.mjs, syncPayment).

export const NOTIFY_PATH = '/api/payments/notify';
export const NOTIFY_EVENTS = ['payment.succeeded', 'payment.canceled', 'refund.succeeded'];

// Частые ошибки при подключении — что проверить до отправки магазина на модерацию.
export const COMMON_MISTAKES = [
  { key: 'webhook_http', title: 'Адрес уведомлений без https, с портом не 443/8443 или с самоподписанным сертификатом',
    hint: 'ЮKassa шлёт уведомления только на https с действующим сертификатом; иначе оплата не отметится сама — только когда заказчик вернётся на сайт.' },
  { key: 'webhook_local', title: 'В кабинете ЮKassa указан адрес площадки, локальный адрес или адрес с ошибкой',
    hint: 'Адрес уведомлений — ровно тот, что показан выше, на домене боевого сайта; для тестового магазина — свой адрес у тестового магазина.' },
  { key: 'webhook_events', title: 'Не отмечены события уведомлений',
    hint: `Отметить: ${NOTIFY_EVENTS.join(', ')}.` },
  { key: 'return_url', title: 'Адрес возврата (return_url) относительный или ведёт не на сайт платформы',
    hint: 'Адрес возврата собирается из PUBLIC_URL: https://…/kabinet.html#order=…; PUBLIC_URL — без «/» в конце, на том же домене, что и сайт.' },
  { key: 'keys_mixed', title: 'Перепутаны ключи: тестовый на боевом сайте или боевой на площадке',
    hint: 'Вне боевого сайта сервер не стартует с боевым ключом, на боевом — с тестовым. Номер магазина и ключ — из одного магазина.' },
  { key: 'receipt_contact', title: 'Чеки включены, а у покупателя нет почты или телефона',
    hint: 'Для чека ЮKassa нужна почта или телефон покупателя. Берём подтверждённую почту из профиля, если её нет — номер телефона входа.' },
  { key: 'moderation_site', title: 'На сайте нет того, что смотрит модерация',
    hint: 'Оферта, цены услуг, контакты, реквизиты юрлица (ИНН, ОГРН, адрес), условия возврата, политика обработки персональных данных.' },
  { key: 'webhook_trust', title: 'Доверие содержимому уведомления',
    hint: 'Уведомление может прислать кто угодно; ядро по номеру платежа само спрашивает ЮKassa (так уже сделано).' },
];

const LOCAL = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)|\.(local|localhost|internal|test)$/i;

// Адрес сайта для ЮKassa: годится ли он для уведомлений и возврата. Ничего не запрашивает.
export function publicUrlProblems(publicUrl, appEnv) {
  const out = [];
  if (!publicUrl) return ['PUBLIC_URL не задан — адрес возврата получится относительным, уведомления слать некуда'];
  let u;
  try { u = new URL(publicUrl); } catch { return ['PUBLIC_URL — не адрес сайта']; }
  if (u.protocol !== 'https:') out.push('PUBLIC_URL не https — ЮKassa не пришлёт уведомления');
  if (u.port && !['443', '8443'].includes(u.port)) out.push(`порт ${u.port} — ЮKassa шлёт уведомления только на 443 или 8443`);
  if (LOCAL.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) out.push(`${u.hostname} — не публичное имя сайта`);
  if (u.pathname !== '/' || u.search || u.hash) out.push('PUBLIC_URL — только адрес сайта, без пути и «?»/«#»');
  if (appEnv === 'prod' && /(^|\.)(stage|demo)[.-]/i.test(u.hostname)) out.push('на боевом сайте PUBLIC_URL указывает на площадку');
  return out;
}

// Проверка: каждый пункт — ok (true — в порядке, false — исправить, null — к сведению).
export function paymentsReadiness(cfg) {
  const yk = cfg.yookassa;
  const live = cfg.providers.payments === 'yookassa';
  const base = cfg.publicUrl;
  const urlProblems = publicUrlProblems(base, cfg.appEnv);
  const items = [];
  const add = (key, title, ok, text) => items.push({ key, title, ok, text });

  add('provider', 'Оплата', live ? true : null,
    live ? (cfg.testMoney ? 'ЮKassa, тестовый магазин — деньги не списываются' : 'ЮKassa, боевой магазин')
      : 'поддельная оплата (проверки и площадка) — ЮKassa ещё не подключена');
  add('public_url', 'Адрес сайта (PUBLIC_URL)', urlProblems.length ? false : true,
    urlProblems.length ? urlProblems.join('; ') : `${base} — https, публичное имя`);
  add('webhook', 'Адрес для уведомлений ЮKassa', urlProblems.length ? false : true,
    base ? `${base}${NOTIFY_PATH} — указать в кабинете ЮKassa: «Интеграция» → «HTTP-уведомления»; события: ${NOTIFY_EVENTS.join(', ')}`
      : 'появится, когда задан PUBLIC_URL');
  add('return_url', 'Адрес возврата после оплаты', urlProblems.length ? false : true,
    base ? `${base}/kabinet.html#order=<номер заявки> — заказчик возвращается в свою заявку, оплату ядро уточняет у ЮKassa`
      : 'относительный — годится только для поддельной оплаты');
  let keys;
  if (!live) keys = [null, 'номер магазина и ключ не нужны, пока оплата поддельная'];
  else if (!/^\d{3,12}$/.test(yk.shopId) || !yk.secretKey) keys = [false, 'нет номера магазина или ключа'];
  else keys = [true, `магазин ${yk.shopId}, ключ ${yk.secretKey.startsWith('test_') ? 'тестовый' : 'боевой'} (сам ключ не показываем)`];
  add('keys', 'Номер магазина и ключ', ...keys);
  add('receipts', 'Чеки 54-ФЗ', yk.receipts ? true : null,
    yk.receipts ? 'включены: в чек — подтверждённая почта из профиля заказчика, без неё — телефон входа'
      : 'выключены — включать только по решению Дамира (и в магазине ЮKassa)');
  const op = cfg.operator;
  const missing = [['ИНН', op.inn], ['ОГРН', op.ogrn], ['адрес', op.address], ['банк', op.bank]].filter(([, v]) => !v).map(([n]) => n);
  add('operator', 'Реквизиты платформы для модерации', missing.length ? false : true,
    missing.length ? `не заполнены: ${missing.join(', ')} — юрлицо платформы ещё не выбрано` : `${op.name}, ИНН ${op.inn}`);
  return {
    ready: items.every((i) => i.ok !== false) && live,
    webhook_url: base ? `${base}${NOTIFY_PATH}` : null,
    events: NOTIFY_EVENTS,
    items,
    mistakes: COMMON_MISTAKES,
  };
}

// Доходит ли уведомление снаружи: сервер шлёт пустое уведомление на свой публичный адрес (как ЮKassa) и ждёт 200.
// Пустое уведомление ничего не меняет: без номера платежа ядро сразу отвечает 200.
export async function probeWebhook(publicUrl, fetchImpl = fetch) {
  if (publicUrlProblems(publicUrl).length) return { ok: false, text: 'сначала исправьте адрес сайта (PUBLIC_URL)' };
  const started = Date.now();
  try {
    const r = await fetchImpl(`${publicUrl}${NOTIFY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'notification', event: 'check' }),
      signal: AbortSignal.timeout(8000), redirect: 'manual',
    });
    const ms = Date.now() - started;
    if (r.status === 200) return { ok: true, text: `адрес отвечает 200 за ${ms} мс` };
    if (r.status >= 300 && r.status < 400) return { ok: false, text: `адрес отвечает переадресацией (${r.status}) — ЮKassa по ней не пойдёт, укажите конечный адрес` };
    return { ok: false, text: `адрес отвечает ${r.status} — ЮKassa будет повторять уведомление сутки` };
  } catch (e) {
    const cert = /cert|ssl|tls/i.test(String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? ''));
    return { ok: false, text: cert ? 'ошибка сертификата https — ЮKassa такой адрес не примет' : 'адрес не отвечает снаружи' };
  }
}
