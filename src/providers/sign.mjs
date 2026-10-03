// Электронная подпись заключения (задачи 2.5, 2.5а). Открепленная подпись: файл не меняется, подпись — отдельный файл.
//   sign.sign({ digest, filename, signer: { id, name }, org? }) → { signature: Buffer, filename, mime, certificate, test }
//   sign.verify({ digest, signature })                          → { valid, reason?, certificate?, signedAt?, test? }
// digest — SHA-256 файла (hex). certificate — { subject, issuer, serial, valid_to, org?, title? }; org — { id, name }:
// подпись организации (руководитель), в сертификате — название организации и должность.
// verify проверяет и подпись из кабинета, и готовый файл подписи, который человек загрузил сам (программа любого УЦ,
// «Госключ»); настоящий поставщик проверяет открепленную подпись CMS и квалифицированность сертификата.
// Настоящий поставщик УКЭП (удостоверяющий центр, облачная подпись или КриптоПро) — только после решения Дамира
// и договора. Поддельная подпись — только на площадке и в автотестах (на prod запрещена настройкой, config.mjs);
// юридической силы не имеет и так и подписана в самом файле.
import crypto from 'node:crypto';
import { makeFake } from './fake.mjs';

// Имя файла подписи рядом с файлом: «Заключение.pdf.sig» — эксперт, «Заключение.pdf.org.sig» — организация (2.5а).
export const signatureFilename = (filename, role) => `${filename}${role === 'org' ? '.org' : ''}.sig`;

const MARK = 'ТЕСТОВАЯ ПОДПИСЬ БЕРТЕЛ ДЕЛО — юридической силы не имеет';
const ISSUER = 'Тестовый удостоверяющий центр (поддельная подпись, только площадка)';
// «Внешняя программа подписи» для проверки загрузки готовой подписи (2.5а): ключ открыт и лежит здесь же — такую подпись
// может сделать кто угодно, поэтому она годится только для площадки и автотестов (поддельная подпись на prod запрещена).
const EXTERNAL_KEY = 'bertel-delo-test-external-ca-v1';
const EXTERNAL_MARK = 'ТЕСТОВАЯ ВНЕШНЯЯ ПОДПИСЬ — юридической силы не имеет';
const EXTERNAL_ISSUER = 'Тестовый внешний удостоверяющий центр (только площадка)';
const hmac = (key, fields) => crypto.createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Готовый файл подписи «из программы УЦ» — для автотестов и прогона площадки. subject — владелец, org — название организации.
export function testExternalSignature({ digest, subject, org = null, title = null }) {
  const certificate = { subject, issuer: EXTERNAL_ISSUER, serial: crypto.createHash('sha256').update(`ext:${subject}:${org}`).digest('hex').slice(0, 20).toUpperCase(), valid_to: '2027-12-31', ...(org ? { org, title: title ?? 'Руководитель' } : {}) };
  const fields = { digest, certificate, signed_at: new Date().toISOString() };
  return Buffer.from(`${JSON.stringify({ mark: EXTERNAL_MARK, ...fields, mac: hmac(EXTERNAL_KEY, fields) }, null, 2)}\n`, 'utf8');
}

// Ключ поддельной подписи — из секрета приложения: подпись, сделанная одной копией ядра на площадке, проверяется другой.
export function fakeSign(appSecret) {
  const key = crypto.createHmac('sha256', String(appSecret)).update('fake-signature-v1').digest();
  const mac = (fields) => hmac(key, fields);
  const serial = (id) => crypto.createHash('sha256').update(`cert:${id}`).digest('hex').slice(0, 20).toUpperCase();

  return makeFake('sign', {
    sign: async ({ digest, filename, signer, org = null }) => {
      const certificate = {
        subject: signer.name, issuer: ISSUER, serial: serial(org ? `${signer.id}:${org.id}` : signer.id), valid_to: '2027-12-31',
        ...(org ? { org: org.name, title: 'Руководитель' } : {}),
      };
      const fields = { digest, certificate, signed_at: new Date().toISOString() };
      const body = { mark: MARK, ...fields, mac: mac(fields) };
      return {
        signature: Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8'),
        filename: `${filename}.sig`,
        mime: 'application/pkcs7-signature',
        certificate,
        test: true,
      };
    },
    verify: async ({ digest, signature }) => {
      let body;
      try { body = JSON.parse(Buffer.from(signature).toString('utf8')); } catch { return { valid: false, reason: 'Файл подписи повреждён' }; }
      const fields = { digest: body?.digest, certificate: body?.certificate, signed_at: body?.signed_at };
      const got = String(body?.mac ?? '');
      // Своя подпись площадки (кабинет) или «внешняя» тестовая (загруженный файл) — обе только тестовые.
      if (!sameHex(got, mac(fields)) && !(body?.mark === EXTERNAL_MARK && sameHex(got, hmac(EXTERNAL_KEY, fields)))) {
        return { valid: false, reason: 'Подпись не принадлежит удостоверяющему центру' };
      }
      if (typeof fields.certificate?.subject !== 'string' || !fields.certificate.subject.trim()) return { valid: false, reason: 'Файл подписи повреждён' };
      if (fields.digest !== digest) return { valid: false, reason: 'Файл изменён после подписи' };
      return { valid: true, certificate: fields.certificate, signedAt: fields.signed_at, test: true };
    },
  });
}
