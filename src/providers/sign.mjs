// Электронная подпись заключения (задача 2.5). Открепленная подпись: файл не меняется, подпись — отдельный файл.
//   sign.sign({ digest, filename, signer: { id, name } }) → { signature: Buffer, filename, mime, certificate, test }
//   sign.verify({ digest, signature })                    → { valid, reason?, certificate?, signedAt? }
// digest — SHA-256 файла (hex). certificate — { subject, issuer, serial, valid_to }.
// Настоящий поставщик УКЭП (удостоверяющий центр, облачная подпись или КриптоПро) — только после решения Дамира
// и договора. Поддельная подпись — только на площадке и в автотестах (на prod запрещена настройкой, config.mjs);
// юридической силы не имеет и так и подписана в самом файле.
import crypto from 'node:crypto';
import { makeFake } from './fake.mjs';

const MARK = 'ТЕСТОВАЯ ПОДПИСЬ БЕРТЕЛ ДЕЛО — юридической силы не имеет';
const ISSUER = 'Тестовый удостоверяющий центр (поддельная подпись, только площадка)';

// Ключ поддельной подписи — из секрета приложения: подпись, сделанная одной копией ядра на площадке, проверяется другой.
export function fakeSign(appSecret) {
  const key = crypto.createHmac('sha256', String(appSecret)).update('fake-signature-v1').digest();
  const mac = (fields) => crypto.createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
  const serial = (id) => crypto.createHash('sha256').update(`cert:${id}`).digest('hex').slice(0, 20).toUpperCase();

  return makeFake('sign', {
    sign: async ({ digest, filename, signer }) => {
      const certificate = { subject: signer.name, issuer: ISSUER, serial: serial(signer.id), valid_to: '2027-12-31' };
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
      const expected = mac(fields);
      const got = String(body?.mac ?? '');
      if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        return { valid: false, reason: 'Подпись не принадлежит удостоверяющему центру' };
      }
      if (fields.digest !== digest) return { valid: false, reason: 'Файл изменён после подписи' };
      return { valid: true, certificate: fields.certificate, signedAt: fields.signed_at };
    },
  });
}
