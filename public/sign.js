// Подпись УКЭП файла результата (2.5, 2.5а): как показать подпись и как выбрать готовый файл подписи.
// Подписывают эксперт и, если он работает от организации, её руководитель; подпись — в кабинете или готовым файлом
// из программы удостоверяющего центра или «Госключа».
import { el } from '/common.js';

const dateTimeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function dayRu(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
export const SIGN_WHO = { expert: 'эксперта', org: 'организации' };
const METHOD_RU = { cabinet: 'в кабинете', upload: 'загружена готовым файлом' };

// Строки об одной подписи: кто, когда, сертификат, способ, тестовая ли.
export function signatureLines(s) {
  const who = s.org ? `${s.org} — ${(s.title ?? 'руководитель').toLowerCase()} ${s.signer}` : s.signer;
  return [
    el('div', { class: `sig-state ${s.checked_ok ? 'ok' : 'bad'}`, text: s.checked_ok
      ? `Подпись ${SIGN_WHO[s.role]}: ${who} · ${dateTimeRu(s.signed_at)}`
      : `Подпись ${SIGN_WHO[s.role]} не сходится с файлом (проверено ${dateTimeRu(s.checked_at)})` }),
    el('div', { class: 'muted', text: `Сертификат № ${s.serial} · действует до ${dayRu(s.valid_to)} · подпись ${METHOD_RU[s.method] ?? ''}` }),
    el('div', { class: 'muted', text: `Выдан: ${s.issuer}` }),
    ...(s.test ? [el('div', { class: 'sig-test', text: 'Тестовая подпись площадки — юридической силы не имеет' })] : []),
  ];
}

// Кнопка «Загрузить готовую подпись»: файл .sig/.p7s/.sgn, подтверждение — и onFile(file).
export function uploadSignatureButton(name, onFile) {
  const input = el('input', { type: 'file', class: 'visually-hidden', accept: '.sig,.p7s,.sgn,.p7m,application/pkcs7-signature',
    'aria-label': `Готовая подпись для «${name}»`, 'data-action': 'sig-file' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (file) onFile(file);
  });
  return [el('label', { class: 'btn secondary', 'data-action': 'sig-upload' }, 'Загрузить готовую подпись', input)];
}

export const SIGN_CONFIRM = (name) => `Подписать «${name}»? Подтверждаю, что проверил документ и отвечаю за него.`;
export const UPLOAD_HINT = 'Готовая подпись — файл .sig, .p7s или .sgn, сделанный в программе удостоверяющего центра или в «Госключе» для этого же файла.';
