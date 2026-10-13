// Разбор файла открепленной подписи (CMS / PKCS#7, .sig .p7s .sgn) без проверки самой подписи (задача штаба 3f817197-…-81ac):
// годится ли файл вообще и чей в нём сертификат — кто подписал, кем выдан, номер, срок. Подпись ГОСТ этим не проверяется:
// при ручной проверке (SIGN_PROVIDER=manual) её проверяет сотрудник платформы на Госуслугах.
//   cmsInfo(buf) → null (это не файл подписи) или { certificate: { subject, issuer, serial, valid_to, org?, title? } | null }
import crypto from 'node:crypto';

const SIGNED_DATA = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]); // 1.2.840.113549.1.7.2

// Файл подписи бывает двоичным (DER/BER) или текстом (PEM «-----BEGIN …» или просто base64).
function toDer(buf) {
  if (buf[0] === 0x30) return buf;
  const s = buf.toString('latin1').replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) return null;
  const der = Buffer.from(s, 'base64');
  return der[0] === 0x30 ? der : null;
}

// Один элемент BER: тег, начало и конец содержимого, конец элемента. Длина «неопределённая» (0x80) — до пары нулей.
function tlv(b, off) {
  if (off + 2 > b.length) throw new Error('short');
  const tag = b[off];
  if ((tag & 0x1f) === 0x1f) throw new Error('long tag');
  let p = off + 1;
  let len = b[p++];
  if (len === 0x80) {
    let q = p;
    while (q + 1 < b.length && !(b[q] === 0 && b[q + 1] === 0)) q = tlv(b, q).next;
    if (q + 1 >= b.length) throw new Error('short');
    return { tag, start: p, end: q, next: q + 2, off };
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > b.length) throw new Error('len');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error('short');
  return { tag, start: p, end: p + len, next: p + len, off };
}
function children(b, el) {
  const out = [];
  for (let p = el.start; p < el.end;) { const c = tlv(b, p); out.push(c); p = c.next; }
  return out;
}

// Поле имени сертификата: «CN=…\nSN=…» → значение (в именах бывают «\», экранирование Node).
function field(name, key) {
  const line = String(name ?? '').split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).replace(/\\(.)/g, '$1').trim() || null : null;
}
const isoDay = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

export function certificateInfo(der) {
  const x = new crypto.X509Certificate(der);
  // Квалифицированный сертификат физлица: фамилия (SN) и имя-отчество (GN) отдельно; иначе — общее имя (CN).
  const sn = field(x.subject, 'SN');
  const gn = field(x.subject, 'GN') ?? field(x.subject, 'G');
  const org = field(x.subject, 'O');
  const title = field(x.subject, 'title') ?? field(x.subject, 'T');
  return {
    subject: sn && gn ? `${sn} ${gn}` : field(x.subject, 'CN') ?? sn ?? '—',
    issuer: field(x.issuer, 'CN') ?? field(x.issuer, 'O') ?? '—',
    serial: x.serialNumber,
    valid_to: isoDay(x.validTo),
    ...(org ? { org } : {}),
    ...(title ? { title } : {}),
    ca: x.ca,
  };
}

export function cmsInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const b = toDer(buf);
  if (!b) return null;
  try {
    const ci = tlv(b, 0);
    if (ci.tag !== 0x30) return null;
    const [oid, wrap] = children(b, ci);
    if (!oid || !b.subarray(oid.off, oid.next).equals(SIGNED_DATA) || wrap?.tag !== 0xa0) return null;
    const sd = children(b, wrap)[0];
    if (sd?.tag !== 0x30) return null;
    // SignedData: версия, алгоритмы, содержимое (пустое — подпись открепленная), [0] сертификаты, …, подписи.
    const certs = children(b, sd).find((c) => c.tag === 0xa0);
    if (!certs) return { certificate: null };
    const list = children(b, certs).filter((c) => c.tag === 0x30).map((c) => {
      try { return certificateInfo(b.subarray(c.off, c.next)); } catch { return null; }
    }).filter(Boolean);
    // В файле бывает вся цепочка — нужен сертификат человека (не удостоверяющего центра).
    const own = list.find((c) => !c.ca) ?? list[0];
    if (!own) return { certificate: null };
    const { ca, ...certificate } = own;
    return { certificate };
  } catch {
    return null;
  }
}
