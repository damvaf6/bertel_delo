// Текст отчёта для ИИ-проверки (задача 2.1): PDF, Word (.docx) и простой текст — по страницам, чтобы отмеченные места
// можно было показать человеку («стр. 3»). Файлы читаются только в памяти сервера, никуда не отправляются, кроме модели ИИ
// из настроек (в контуре РФ). Что прочитать не удалось — null: проверяющий смотрит такой файл сам.
import zlib from 'node:zlib';

// Отчёт с фото бывает 50 МБ и больше (2.49): читаем до 100 МБ — PDF на 27 МБ читается за десятые доли секунды.
export const READ_MAX_BYTES = 100 * 1024 * 1024;
const UNZIP_TEXT_MAX = 50 * 1024 * 1024; // текст Word в распакованном виде (защита от «архивной бомбы»)
const PDF_MAX_PAGES = 300;

export function readableKind(filename, mime) {
  if (/\.pdf$/i.test(filename) || mime === 'application/pdf') return 'pdf';
  if (/\.docx$/i.test(filename) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (/^text\//.test(mime) || /\.(txt|md|csv)$/i.test(filename)) return 'text';
  return null;
}

// → { kind, pages: [строки страниц] } или null (вид файла не читается, файл повреждён или пустой).
export async function extractPages(buf, filename, mime) {
  const kind = readableKind(filename, mime);
  if (!kind || !buf || buf.length > READ_MAX_BYTES) return null;
  try {
    let pages;
    if (kind === 'text') pages = [buf.toString('utf8')];
    else if (kind === 'docx') pages = docxPages(buf);
    else pages = await pdfPages(buf);
    pages = (pages ?? []).map((p) => p.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim());
    if (!pages.some((p) => /[\p{L}\d]/u.test(p))) return null;
    return { kind, pages };
  } catch {
    return null;
  }
}

async function pdfPages(buf) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    if (pdf.numPages > PDF_MAX_PAGES) return null;
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } finally {
    await pdf.destroy?.();
  }
}

// ——— Word (.docx): архив, в нём word/document.xml ———

function unzipEntry(buf, wanted) {
  // Конец центрального каталога: ищем подпись с конца (комментарий архива — до 64 КБ).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (name === wanted) {
      if (usize > UNZIP_TEXT_MAX) return null;
      const lnlen = buf.readUInt16LE(local + 26);
      const lxlen = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: UNZIP_TEXT_MAX });
      return null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

function docxPages(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) return null;
  const body = xml.toString('utf8');
  const pages = [''];
  // Разрывы страниц — явные и те, что Word запомнил при последнем показе.
  const re = /<w:br\b[^>]*w:type="page"[^>]*\/>|<w:lastRenderedPageBreak\/>|<w:tab\/>|<\/w:p>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[0];
    if (tag.startsWith('<w:br') || tag.startsWith('<w:lastRendered')) { if (pages[pages.length - 1].trim()) pages.push(''); }
    else if (tag === '<w:tab/>') pages[pages.length - 1] += '\t';
    else if (tag === '</w:p>') pages[pages.length - 1] += '\n';
    else pages[pages.length - 1] += decode(m[1]);
  }
  return pages;
}

// ——— Отмеченные места: цитаты из ответа модели сверяются с текстом отчёта ———

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"„“”]/g, '"').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();

// Где в отчёте цитата: файл и страница (у простого текста — строка). Не нашлась — модель её выдумала, не показываем.
export function locateQuote(docs, quote) {
  const q = norm(quote);
  if (q.length < 4) return null;
  for (const d of docs) {
    if (!d.pages) continue;
    for (let i = 0; i < d.pages.length; i += 1) {
      const page = d.pages[i];
      if (!norm(page).includes(q)) continue;
      if (d.kind === 'text') {
        const lines = page.split('\n');
        const line = lines.findIndex((l, k) => norm(lines.slice(k, k + 5).join(' ')).includes(q));
        return { file: d.name, where: line >= 0 ? `строка ${line + 1}` : 'в тексте' };
      }
      return { file: d.name, where: d.pages.length > 1 ? `стр. ${i + 1}` : 'стр. 1' };
    }
  }
  return null;
}
