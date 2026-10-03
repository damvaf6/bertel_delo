// Тестовые отчёты для ИИ-проверки (задача 2.1): PDF с русским текстом и Word (.docx) — без внешних программ.
// PDF: шрифт Type0 / Identity-H, код символа = его номер в Юникоде, карта ToUnicode — как у PDF из Word или «1С».
// Word: минимальный архив (без сжатия) с word/document.xml.
import zlib from 'node:zlib';

const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();

export function makePdf(pages) {
  const chars = [...new Set(pages.flat().join(''))].map((c) => c.codePointAt(0)).filter((c) => c <= 0xffff).sort((a, b) => a - b);
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    ...chunks(chars, 100).flatMap((part) => [`${part.length} beginbfchar`, ...part.map((c) => `<${hex4(c)}> <${hex4(c)}>`), 'endbfchar']),
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const stream = (dict, data, deflate = true) => {
    const raw = Buffer.from(data, 'latin1');
    const body = deflate ? zlib.deflateSync(raw) : raw;
    return Buffer.concat([Buffer.from(`<< ${dict}${deflate ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]);
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const toUnicode = add(stream('', cmap));
  const cid = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + (objs.length + 2) + ' 0 R /DW 600 >>');
  const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /TestSans /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  add('<< /Type /FontDescriptor /FontName /TestSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>');
  const kids = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td', ...lines.map((l) => `<${[...l].map((c) => hex4(c.codePointAt(0))).join('')}> Tj T*`), 'ET'].join('\n');
    const content = add(stream('', ops));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(pos); pos += b.length; parts.push(b);
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer', `<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>`, 'startxref', String(pos), '%%EOF'].join('\n');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

function chunks(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

// .docx: абзацы; '\f' в начале абзаца — разрыв страницы перед ним.
// extra — дополнительные части архива (например, макросы word/vbaProject.bin для проверки отказа).
export function makeDocx(paragraphs, extra = {}) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map((p) => {
    const brk = p.startsWith('\f') ? '<w:r><w:br w:type="page"/></w:r>' : '';
    const t = p.replace(/^\f/, '');
    return `<w:p>${brk}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  }).join('');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  };
  return zip({ ...files, ...extra });
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
