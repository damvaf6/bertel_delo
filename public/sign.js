// Подпись УКЭП файла результата (2.5, 2.5а): как показать подпись и как выбрать готовый файл подписи.
// Подписывают эксперт и, если он работает от организации, её руководитель; подпись — в кабинете или готовым файлом
// из программы удостоверяющего центра или «Госключа».
import { el } from '/common.js';

const dateTimeRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function dayRu(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
export const SIGN_WHO = { expert: 'эксперта', org: 'организации' };
const METHOD_RU = { cabinet: 'в кабинете', upload: 'загружена готовым файлом' };

// Ручная проверка (SIGN_PROVIDER=manual, задача штаба 3f817197-…-81ac): подпись загружена файлом, проверяет платформа на
// Госуслугах — «ждёт проверки», «подписано КЭП, проверено» или «не подтвердилась» с причиной.
function manualLines(s) {
  const who = s.signer ? (s.org ? `${s.signer} (${s.org})` : s.signer) : 'владелец не указан в файле подписи';
  const state = {
    ok: el('div', { class: 'sig-state ok', 'data-sig': 'manual-ok', text: `Подписано КЭП, проверено: ${who}` }),
    pending: el('div', { class: 'sig-state warn', 'data-sig': 'manual-pending', text: `Подпись ${SIGN_WHO[s.role]} загружена — ждёт проверки платформой на Госуслугах · ${who}` }),
    bad: el('div', { class: 'sig-state bad', 'data-sig': 'manual-bad', text: `Подпись ${SIGN_WHO[s.role]} не подтвердилась при проверке${s.manual_note ? `: ${s.manual_note}` : ''}` }),
  }[s.manual_check];
  return [
    state,
    ...(s.manual_check === 'ok' && s.manual_checked_at ? [el('div', { class: 'muted', text: `Платформа проверила подпись на Госуслугах ${dateTimeRu(s.manual_checked_at)}` })] : []),
    ...(s.serial ? [el('div', { class: 'muted', 'data-sig': 'method', text: `Сертификат № ${s.serial}${s.valid_to ? ` · действует до ${dayRu(s.valid_to)}` : ''} · подпись загружена файлом ${dateTimeRu(s.signed_at)}` })] : []),
    ...(s.issuer ? [el('div', { class: 'muted', text: `Выдан: ${s.issuer}` })] : []),
  ];
}

// Строки об одной подписи: кто, когда, сертификат, способ, тестовая ли.
export function signatureLines(s) {
  if (s.manual_check) return manualLines(s);
  const who = s.org ? `${s.org} — ${(s.title ?? 'руководитель').toLowerCase()} ${s.signer}` : s.signer;
  return [
    el('div', { class: `sig-state ${s.checked_ok ? 'ok' : 'bad'}`, text: s.checked_ok
      ? `Подпись ${SIGN_WHO[s.role]}: ${who} · ${dateTimeRu(s.signed_at)}`
      : `Подпись ${SIGN_WHO[s.role]} не сходится с файлом (проверено ${dateTimeRu(s.checked_at)})` }),
    el('div', { class: 'muted', 'data-sig': 'method', text: `Сертификат № ${s.serial} · действует до ${dayRu(s.valid_to)} · подпись ${METHOD_RU[s.method] ?? ''}${s.method === 'upload' && s.app ? ` из приложения «${s.app}»` : ''}` }),
    el('div', { class: 'muted', text: `Выдан: ${s.issuer}` }),
    ...(s.test ? [el('div', { class: 'sig-test', text: 'Тестовая подпись площадки — юридической силы не имеет' })] : []),
  ];
}

// Кнопка «Загрузить готовую подпись»: файл .sig/.p7s/.sgn, подтверждение — и onFile(file).
export function uploadSignatureButton(name, onFile, label = 'Загрузить готовую подпись') {
  const input = el('input', { type: 'file', class: 'visually-hidden', accept: '.sig,.p7s,.sgn,.p7m,application/pkcs7-signature',
    'aria-label': `Готовая подпись для «${name}»`, 'data-action': 'sig-file' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (file) onFile(file);
  });
  return [el('label', { class: 'btn secondary', 'data-action': 'sig-upload' }, label, input)];
}

export const SIGN_CONFIRM = (name) => `Подписать «${name}»? Подтверждаю, что проверил документ и отвечаю за него.`;
export const UPLOAD_HINT = 'Готовая подпись — файл .sig, .p7s или .sgn, сделанный в программе удостоверяющего центра или в «Госключе» для этого же файла.';
export const MANUAL_HINT = 'Подпишите этот файл своей квалифицированной подписью (КЭП) — в КриптоПро, программе удостоверяющего центра или в «Госключе» — и загрузите получившийся файл подписи .sig. Файл после подписи не меняйте. Платформа проверит подпись на Госуслугах.';

// Памятки (задача штаба 3f817197-…-81ac): как подписать файл КЭП и как подать подписанный отчёт в суд электронно. Строка про
// нотариальное заверение перевода — в обеих: подпись переводчика не заменяет нотариуса.
const NOTARY_LINE = 'Перевод, подписанный КЭП переводчика, — не нотариально заверенный перевод. Если получатель требует нотариальное заверение, закажите перевод с нотариусом: подпись переводчика заверит нотариус.';
export const SIGN_HOWTO = [
  'Нужна Ваша квалифицированная электронная подпись (КЭП) — от удостоверяющего центра, ФНС или в приложении «Госключ». Платформа Ваш ключ не видит и не хранит.',
  'Сначала окончательно загрузите файл результата сюда. Подписывайте именно этот файл — после подписи в нём нельзя менять ни буквы, иначе подпись к нему не подойдёт.',
  'КриптоПро CSP с КриптоАРМ или программа Вашего удостоверяющего центра: «Подписать» → подпись «отсоединённая» (открепленная) → получится файл с тем же именем и окончанием .sig.',
  '«Госключ»: подпишите документ в приложении и сохраните файл подписи .sig.',
  'Нажмите «Загрузить файл подписи (.sig)» у этого файла. Платформа хранит файл и подпись вместе и проверяет подпись на Госуслугах — когда проверит, у файла появится «Подписано КЭП, проверено».',
  NOTARY_LINE,
];
export const COURT_HOWTO = [
  'Скачайте два файла: сам отчёт («Скачать») и его подпись («Файл подписи»; если отчёт подписала и организация — ещё «Подпись организации»). Файлы не переименовывайте и не меняйте.',
  'Арбитражный суд — «Мой арбитр» (my.arbitr.ru), вход через Госуслуги: к заявлению или ходатайству приложите отчёт и рядом его файл подписи .sig.',
  'Суд общей юрисдикции и мировой судья — ГАС «Правосудие» (ej.sudrf.ru), вход через Госуслуги: «Подача процессуальных документов» → выберите суд → приложите отчёт и файл подписи .sig.',
  'Отчёт с подписью КЭП эксперта — электронный документ; распечатывать и заверять его не нужно. Проверить подпись сами можете на Госуслугах (gosuslugi.ru/eds, «Отсоединённая подпись»).',
  NOTARY_LINE,
];
export function memo(title, lines, role) {
  return el('details', { class: 'fold memo', 'data-memo': role },
    el('summary', { text: title }),
    el('ol', { class: 'howto' }, ...lines.map((t) => el('li', { text: t }))));
}
export const GOSUSLUGI_CHECK_URL = 'https://www.gosuslugi.ru/eds';
