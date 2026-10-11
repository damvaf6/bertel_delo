// QR-код без внешних библиотек (2а.5, сертификат платформы): ссылка на страницу проверки → картинка PNG для листа Word.
// Режим «байты», уровень коррекции M (до 15% повреждений), версии 1–10 (до 213 байт — ссылке хватает с запасом).
// Устроено по стандарту ISO/IEC 18004: данные → коды Рида — Соломона → размещение → лучшая из 8 масок.
import zlib from 'node:zlib';

const MAX_VERSION = 10;
// Уровень M: кодов коррекции на блок и число блоков по версиям (индекс — версия).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0; // два бита уровня M в строке формата

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// Сколько модулей версии отведено под данные и коррекцию.
function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// Поле Галуа GF(256), многочлен 0x11D.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < r.length; j += 1) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    divisor.forEach((d, i) => { r[i] ^= gfMul(d, f); });
  }
  return r;
}

// Данные → кодовые слова с коррекцией, перемешанные по блокам.
function codewords(bytes, ver) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i -= 1) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const nBlocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i += 1) {
    const len = shortLen - eccLen + (i < nShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
  }
  return out;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Штраф маски (правила стандарта): длинные ряды одного цвета, квадраты 2×2, похожее на угловой узор, перекос тёмного.
function penalty(m) {
  const size = m.length;
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      for (let b = 1; b <= size; b += 1) {
        if (b < size && get(a, b) === get(a, b - 1)) { run += 1; continue; }
        if (run >= 5) p += run - 2;
        run = 1;
      }
      for (let b = 0; b + 10 < size + 1; b += 1) {
        const s = Array.from({ length: 11 }, (_, k) => (b + k < size ? (get(a, b + k) ? 1 : 0) : 0)).join('');
        if (b + 11 <= size && (s === '10111010000' || s === '00001011101')) p += 40;
      }
    }
  };
  line((y, x) => m[y][x]);
  line((x, y) => m[y][x]);
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  }
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
  return p;
}

// Матрица QR-кода: массив строк, true — тёмный модуль.
export function qrMatrix(textValue) {
  const bytes = [...Buffer.from(String(textValue), 'utf8')];
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver += 1;
  if (ver > MAX_VERSION) throw new Error('QR: слишком длинный текст');
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx; const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignmentPositions(ver);
  const last = al.length - 1;
  al.forEach((ay, i) => al.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mask) => {
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(b, i));
    set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(b, i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3); const c = Math.floor(i / 3);
      set(a, c, bit(b, i)); set(c, a, bit(b, i));
    }
  }

  const cw = codewords(bytes, ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (!fn[y][x] && i < cw.length * 8) { mod[y][x] = bit(cw[i >>> 3], 7 - (i & 7)); i += 1; }
      }
    }
  }

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const f = MASKS[mask];
    const m = mod.map((row, y) => row.map((d, x) => (fn[y][x] ? d : d !== f(x, y))));
    const keep = mod.map((row) => row.slice());
    mod.forEach((row, y) => row.forEach((_, x) => { mod[y][x] = m[y][x]; }));
    format(mask);
    const p = penalty(mod);
    if (!best || p < best.p) best = { p, m: mod.map((row) => row.slice()) };
    keep.forEach((row, y) => row.forEach((d, x) => { mod[y][x] = d; }));
  }
  return best.m;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// QR-код картинкой PNG (чёрно-белая, 8 бит): scale точек на модуль, поле 4 модуля со всех сторон.
export function qrPng(textValue, scale = 8) {
  const m = qrMatrix(textValue);
  const n = (m.length + 8) * scale;
  const rows = [];
  for (let py = 0; py < n; py += 1) {
    const row = Buffer.alloc(n + 1, 255);
    row[0] = 0;
    const y = Math.floor(py / scale) - 4;
    if (y >= 0 && y < m.length) for (let px = 0; px < n; px += 1) {
      const x = Math.floor(px / scale) - 4;
      if (x >= 0 && x < m.length && m[y][x]) row[px + 1] = 0;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
