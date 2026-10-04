// Word (.docx) из текста черновика (2.2): строки «## Название» — заголовки, остальные — абзацы.
// Задача 2.29: отчёт со структурой настоящего — титул, оглавление, нумерованные разделы, таблицы из строк «| a | b |»,
// колонтитул с номером отчёта и страницей (buildReport); по шаблону организации (.docx: стили, шапка, логотип, реквизиты)
// — содержимое вставляется в него. Без внешних библиотек; Word, LibreOffice и «Мой Офис» открывают такие файлы.
import zlib from 'node:zlib';
import { HttpError } from '../http/core.mjs';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
const UNZIP_MAX_BYTES = 40 * 1024 * 1024;   // всё содержимое шаблона в распакованном виде (защита от «архивной бомбы»)
const UNZIP_MAX_ENTRIES = 500;
// Место для отчёта в шаблоне: абзац с этим текстом заменяется отчётом; нет его — отчёт идёт после содержимого шаблона.
export const TEMPLATE_MARK = '{{ОТЧЁТ}}';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const IMAGE_CT = { png: 'image/png', jpeg: 'image/jpeg' };
const mediaRels = (media) => media.map((m) => `<Relationship Id="${m.rid}" Type="${IMAGE_REL}" Target="media/delo${m.n}.${m.ext}"/>`).join('');
const mediaTypes = (media) => [...new Set(media.map((m) => m.ext))].map((e) => `<Default Extension="${e}" ContentType="${IMAGE_CT[e]}"/>`).join('');
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

// Символы, которых не может быть в XML 1.0, — убираем; остальное экранируем.
const esc = (s) => String(s).replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_A4 = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/>';

// ——— Отчёт (2.29) ———

// Разбор текста черновика: заголовки «#», таблицы — подряд идущие строки «| … |» (строка «|---|» — только разделитель),
// остальное — абзацы. Пустые строки не переносятся: отступы задают стили.
export function parseDraft(text) {
  const blocks = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const head = line.match(/^(#{1,3})\s*(.+)$/);
    if (head) { blocks.push({ type: 'head', level: head[1].length <= 2 ? 1 : 2, text: head[2].trim() }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const last = blocks[blocks.length - 1];
      if (last?.type === 'table') last.rows.push(cells);
      else blocks.push({ type: 'table', rows: [cells] });
      continue;
    }
    if (line.trim()) blocks.push({ type: 'para', text: line.trim() });
  }
  return blocks;
}

// Нумерация разделов: заголовок уже с номером («2. Задание на оценку») — номер берётся из него; иначе — следующий по порядку.
function numbered(blocks) {
  let n = 0;
  let sub = 0;
  return blocks.map((b) => {
    if (b.type !== 'head' || b.plain) return b;
    const own = b.text.match(/^(\d+)(?:\.(\d+))?\.?\s+/);
    if (b.level === 1) {
      n = own ? Number(own[1]) : n + 1;
      sub = 0;
      return { ...b, text: own ? b.text : `${n}. ${b.text}` };
    }
    sub = own?.[2] ? Number(own[2]) : sub + 1;
    return { ...b, text: own ? b.text : `${n}.${sub}. ${b.text}` };
  });
}

const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const pStyle = (id) => `<w:pStyle w:val="${id}"/>`;
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function table(rows, st) {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(9355 / cols);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`;
  const head = `<w:tblPr><w:tblStyle w:val="${st.table}"/><w:tblW w:w="5000" w:type="pct"/>${borders}`
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>`;
  const body = rows.map((r, i) => `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, k) => (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(run(r[k] ?? '', i === 0 ? '<w:b/>' : ''), '<w:spacing w:before="0" w:after="0"/><w:jc w:val="left"/>')}</w:tc>`
  )).join('')}</w:tr>`).join('');
  // После таблицы — пустой абзац: две таблицы подряд Word склеил бы в одну.
  return `<w:tbl>${head}${body}</w:tbl>${para('')}`;
}

// Оглавление — поле Word (обновляется при открытии: w:dirty) с готовым списком разделов внутри на случай, если программа
// поля не обновляет.
function toc(heads, st) {
  const items = heads.length ? heads : [{ level: 1, text: 'Разделы появятся после обновления поля' }];
  return items.map((h, i) => {
    const begin = i === 0
      ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      : '';
    const end = i === items.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : '';
    return para(`${begin}${run(h.text)}${end}`, pStyle(h.level === 1 ? st.toc1 : st.toc2));
  }).join('');
}

function titlePage(meta, st) {
  const center = '<w:jc w:val="center"/>';
  return [
    meta.org ? para(run(meta.org, '<w:b/>'), `${center}<w:spacing w:after="0"/>`) : '',
    para('', `<w:spacing w:before="2400"/>`),
    para(run(`${meta.title.toUpperCase()} ${meta.number}`), `${pStyle(st.title)}${center}`),
    meta.subtitle ? para(run(meta.subtitle, '<w:sz w:val="28"/>'), center) : '',
    para('', '<w:spacing w:before="1200"/>'),
    meta.executor ? para(run(`Исполнитель: ${meta.executor}`), '<w:jc w:val="right"/>') : '',
    para(run(`Дата составления: ${meta.date}`), '<w:jc w:val="right"/>'),
    para('', '<w:spacing w:before="2400"/>'),
    para(run(`${meta.city}, ${meta.date.slice(-4)}`), center),
    PAGE_BREAK,
  ].join('');
}

// Картинка в тексте (приложение со скриншотами, 2.32): по ширине страницы, высота — не больше страницы, пропорции свои.
const EMU_PX = 9525;
const MAX_W = 5900000;   // ≈ 16,4 см — ширина текста на A4 с нашими полями
const MAX_H = 7900000;   // ≈ 22 см
function drawing(img, n) {
  let w = img.w * EMU_PX;
  let h = img.h * EMU_PX;
  const k = Math.min(1, MAX_W / w, MAX_H / h);
  w = Math.round(w * k);
  h = Math.round(h * k);
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${n}" name="Рисунок ${n}"/>`
    + `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}">`
    + `<pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${img.ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${img.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

// Размер картинки в точках по заголовку файла: PNG (IHDR) и JPEG (кадр SOF). Не узнали — null (картинка не вставляется).
export function imageSize(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { ext: 'jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// Приложение к отчёту (2.32): { title, items: [{ title, lines: [строки], image: Buffer | null }] } → блоки для отчёта и
// картинки, которые надо положить в файл (media). Картинка неизвестного вида не вставляется — остаётся подпись.
// Можно передать список приложений (2.37: фото осмотра, затем скриншоты объявлений) — идут по порядку.
function appendixBlocks(appendix, media) {
  if (Array.isArray(appendix)) return appendix.flatMap((a) => appendixBlocks(a, media));
  if (!appendix?.items?.length) return [];
  const out = [{ type: 'break' }, { type: 'head', level: 1, text: appendix.title, plain: true }];
  for (const it of appendix.items) {
    out.push({ type: 'head', level: 2, text: it.title, plain: true });
    for (const l of it.lines) out.push({ type: 'para', text: l });
    const size = it.image ? imageSize(it.image) : null;
    if (size && size.w > 0 && size.h > 0) {
      const img = { ...size, buf: it.image, n: media.length + 1, rid: `rIdDeloImg${media.length + 1}` };
      media.push(img);
      out.push({ type: 'image', img });
    }
  }
  return out;
}

function reportBody(text, meta, st, appendix = null, media = []) {
  const blocks = [...numbered(parseDraft(text)), ...appendixBlocks(appendix, media)];
  const heads = blocks.filter((b) => b.type === 'head');
  const content = blocks.map((b) => {
    if (b.type === 'head') return para(run(b.text), pStyle(b.level === 1 ? st.h1 : st.h2));
    if (b.type === 'table') return table(b.rows, st);
    if (b.type === 'break') return PAGE_BREAK;
    if (b.type === 'image') return para(drawing(b.img, b.img.n), '<w:jc w:val="center"/><w:keepNext/>');
    return para(run(b.text));
  }).join('');
  return titlePage(meta, st) + para(run('Содержание'), `${pStyle(st.title)}<w:jc w:val="center"/>`) + toc(heads, st) + PAGE_BREAK + content;
}

const footerXml = (meta) => `${XML_HEAD}<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
  + `${run(`${meta.title} ${meta.number} · стр. `, '<w:sz w:val="20"/>')}`
  + '<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>';

// Стили, которые нужны отчёту: имя в Word → описание. В шаблоне ищутся по имени (у русского Word другие id: «1» и т. п.).
const STYLES = {
  normal: { name: 'Normal', id: 'Normal', type: 'paragraph', xml: '<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/></w:rPr>' },
  title: { name: 'Title', id: 'DeloTitle', type: 'paragraph', xml: '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' },
  h1: { name: 'heading 1', id: 'Heading1', type: 'paragraph', xml: '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' },
  h2: { name: 'heading 2', id: 'Heading2', type: 'paragraph', xml: '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr>' },
  toc1: { name: 'toc 1', id: 'TOC1', type: 'paragraph', xml: '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:jc w:val="left"/></w:pPr>' },
  toc2: { name: 'toc 2', id: 'TOC2', type: 'paragraph', xml: '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="284"/><w:jc w:val="left"/></w:pPr>' },
  table: { name: 'Table Grid', id: 'TableGrid', type: 'table', xml: '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders></w:tblPr>' },
};

const styleXml = (s, id) => `<w:style w:type="${s.type}"${s.name === 'Normal' ? ' w:default="1"' : ''} w:styleId="${id}"><w:name w:val="${s.name}"/>${s.xml}</w:style>`;

function ownStyles() {
  const st = Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, s.id]));
  const xml = `${XML_HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault></w:docDefaults>`
    + `${Object.values(STYLES).map((s) => styleXml(s, s.id)).join('')}</w:styles>`;
  return { st, xml };
}

// Стили шаблона остаются как есть (в этом смысл шаблона); каких не хватает — дописываются со своими id.
function mergeStyles(xml) {
  const byName = new Map();
  for (const m of xml.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name\s+w:val="([^"]+)"/g)) {
    if (!byName.has(m[2].toLowerCase())) byName.set(m[2].toLowerCase(), m[1]);
  }
  const ids = new Set([...xml.matchAll(/\bw:styleId="([^"]+)"/g)].map((m) => m[1]));
  const st = {};
  let add = '';
  for (const [k, s] of Object.entries(STYLES)) {
    const have = byName.get(s.name.toLowerCase());
    if (have) { st[k] = have; continue; }
    let id = `Delo${s.id}`;
    while (ids.has(id)) id += '1';
    ids.add(id);
    st[k] = id;
    // basedOn «Normal» в шаблоне может называться иначе.
    add += styleXml(s, id).replace('<w:basedOn w:val="Normal"/>', byName.has('normal') ? `<w:basedOn w:val="${byName.get('normal')}"/>` : '');
  }
  return { st, xml: add ? xml.replace(/<\/w:styles>\s*$/, `${add}</w:styles>`) : xml };
}

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

function contentTypes(parts) {
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/word/document.xml" ContentType="${MAIN_CT}"/>`
    + parts.map(([name, ct]) => `<Override PartName="/${name}" ContentType="${ct}"/>`).join('')
    + '</Types>';
}

const STYLES_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const FOOTER_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
const FOOTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

// meta: { title: 'Отчёт об оценке', number: '№ …', subtitle, org, executor, date: 'дд.мм.гггг', city }.
// template — Buffer шаблона организации (.docx, уже проверенный checkTemplate) или null.
// appendix — приложение после разделов (скриншоты объявлений, 2.32; фото осмотра, 2.37) или список приложений: см. appendixBlocks.
export function buildReport(text, meta, template = null, { appendix = null } = {}) {
  const m = { city: 'г. Москва', ...meta };
  if (template) return intoTemplate(text, m, template, appendix);
  const { st, xml: styles } = ownStyles();
  const media = [];
  const body = reportBody(text, m, st, appendix, media);
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rId2"/>${PAGE_A4}<w:titlePg/></w:sectPr>`;
  return zip([
    ['[Content_Types].xml', contentTypes([['word/styles.xml', STYLES_CT], ['word/footer1.xml', FOOTER_CT]]).replace('<Default Extension="xml"', `${mediaTypes(media)}<Default Extension="xml"`)],
    ['_rels/.rels', ROOT_RELS],
    ['word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${STYLES_REL}" Target="styles.xml"/><Relationship Id="rId2" Type="${FOOTER_REL}" Target="footer1.xml"/>${mediaRels(media)}</Relationships>`],
    ['word/styles.xml', styles],
    ['word/footer1.xml', footerXml(m)],
    ['word/document.xml', `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}"><w:body>${body}${sect}</w:body></w:document>`],
    ...media.map((x) => [`word/media/delo${x.n}.${x.ext}`, x.buf]),
  ]);
}

const paraText = (p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('');

// Отчёт в шаблоне: стили, колонтитулы, логотип и поля страницы — из шаблона; содержимое шаблона (шапка, реквизиты) остаётся,
// отчёт встаёт на место абзаца «{{ОТЧЁТ}}» или после содержимого. Нет своего нижнего колонтитула — добавляется наш.
function intoTemplate(text, meta, template, appendix = null) {
  const files = unzip(template);
  const get = (name) => files.find((f) => f.name === name);
  const docPath = mainPart(files);
  const doc = get(docPath).data.toString('utf8');
  const dir = docPath.replace(/[^/]+$/, '');
  const relsPath = `${dir}_rels/${docPath.slice(dir.length)}.rels`;
  let rels = get(relsPath)?.data.toString('utf8')
    ?? `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  let types = get('[Content_Types].xml').data.toString('utf8')
    .replace(/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.template\.main\+xml/g, MAIN_CT);

  let st;
  const stylesTarget = rels.match(/<Relationship\b[^>]*Type="[^"]*\/styles"[^>]*Target="([^"]+)"/)
    ?? rels.match(/<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/styles"/);
  if (stylesTarget) {
    const sp = `${dir}${stylesTarget[1].replace(/^\//, '')}`;
    const f = get(sp) ?? get(stylesTarget[1].replace(/^\//, ''));
    const merged = mergeStyles(f.data.toString('utf8'));
    st = merged.st;
    f.data = Buffer.from(merged.xml, 'utf8');
  } else {
    const own = ownStyles();
    st = own.st;
    files.push({ name: `${dir}styles.xml`, data: Buffer.from(own.xml, 'utf8') });
    rels = rels.replace('</Relationships>', `<Relationship Id="rIdDeloStyles" Type="${STYLES_REL}" Target="styles.xml"/></Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/${dir}styles.xml" ContentType="${STYLES_CT}"/></Types>`);
  }

  const open = doc.match(/<w:body\b[^>]*>/);
  const close = doc.lastIndexOf('</w:body>');
  if (!open || close < 0) throw new Error('шаблон без содержимого');
  const start = open.index + open[0].length;
  let inner = doc.slice(start, close);
  const sectAt = inner.lastIndexOf('<w:sectPr');
  let sect = sectAt >= 0 ? inner.slice(sectAt) : `<w:sectPr>${PAGE_A4}</w:sectPr>`;
  if (sectAt >= 0) inner = inner.slice(0, sectAt);

  const media = [];
  const report = reportBody(text, meta, st, appendix, media);
  if (media.length) {
    rels = rels.replace('</Relationships>', `${mediaRels(media)}</Relationships>`);
    const missing = [...new Set(media.map((x) => x.ext))].filter((e) => !new RegExp(`<Default\\b[^>]*Extension="${e}"`, 'i').test(types));
    types = types.replace(/(<Types\b[^>]*>)/, `$1${mediaTypes(media.filter((x) => missing.includes(x.ext)))}`);
    for (const x of media) files.push({ name: `${dir}media/delo${x.n}.${x.ext}`, data: x.buf });
  }
  const mark = [...inner.matchAll(/<w:p\b(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find((p) => paraText(p[0]).includes(TEMPLATE_MARK));
  inner = mark ? inner.slice(0, mark.index) + report + inner.slice(mark.index + mark[0].length) : inner + report;

  if (!/<w:footerReference\b/.test(sect)) {
    files.push({ name: `${dir}footerDelo.xml`, data: Buffer.from(footerXml(meta), 'utf8') });
    rels = rels.replace('</Relationships>', `<Relationship Id="rIdDeloFooter" Type="${FOOTER_REL}" Target="footerDelo.xml"/></Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/${dir}footerDelo.xml" ContentType="${FOOTER_CT}"/></Types>`);
    // Ссылки на колонтитулы идут первыми в описании раздела.
    sect = sect.replace(/^<w:sectPr\b[^>]*?(\/?)>/, (tag, selfClose) => (selfClose
      ? `${tag.replace(/\/>$/, '>')}<w:footerReference w:type="default" r:id="rIdDeloFooter"/></w:sectPr>`
      : `${tag}<w:footerReference w:type="default" r:id="rIdDeloFooter"/>`));
  }
  let head = doc.slice(0, start);
  if (!/xmlns:r=/.test(head.match(/<w:document\b[^>]*>/)?.[0] ?? '')) head = head.replace(/<w:document\b/, `<w:document xmlns:r="${R}"`);
  if (media.length && !/xmlns:wp=/.test(head.match(/<w:document\b[^>]*>/)?.[0] ?? '')) head = head.replace(/<w:document\b/, `<w:document xmlns:wp="${WP}"`);

  const out = files.filter((f) => f.name !== docPath && f.name !== relsPath && f.name !== '[Content_Types].xml');
  return zip([
    ['[Content_Types].xml', types],
    [relsPath, rels],
    [docPath, head + inner + sect + doc.slice(close)],
    ...out.map((f) => [f.name, f.data]),
  ]);
}

// Простой документ (2.46): счёт, акт, отчёт агента, документ о возврате — заголовок, строки, таблица, подписи.
// blocks: [{ type: 'title' | 'para' | 'bold' | 'note', text } | { type: 'table', rows: [[…]] } | { type: 'sign', text }].
export function buildSimpleDoc(blocks) {
  const { st, xml: styles } = ownStyles();
  const body = blocks.map((b) => {
    if (b.type === 'table') return table(b.rows, st);
    if (b.type === 'title') return para(run(b.text, '<w:b/><w:sz w:val="28"/>'), '<w:jc w:val="center"/><w:spacing w:after="240"/>');
    if (b.type === 'bold') return para(run(b.text, '<w:b/>'));
    if (b.type === 'note') return para(run(b.text, '<w:i/><w:color w:val="9B1C1C"/>'));
    if (b.type === 'sign') return para(run(b.text), '<w:spacing w:before="480"/>');
    return para(run(b.text));
  }).join('');
  return zip([
    ['[Content_Types].xml', contentTypes([['word/styles.xml', STYLES_CT]])],
    ['_rels/.rels', ROOT_RELS],
    ['word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${STYLES_REL}" Target="styles.xml"/></Relationships>`],
    ['word/styles.xml', styles],
    ['word/document.xml', `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr>${PAGE_A4}</w:sectPr></w:body></w:document>`],
  ]);
}

// Главная часть документа — по _rels/.rels (обычно word/document.xml).
function mainPart(files) {
  const rels = files.find((f) => f.name === '_rels/.rels')?.data.toString('utf8') ?? '';
  const m = rels.match(/<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*Target="([^"]+)"/)
    ?? rels.match(/<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/officeDocument"/);
  return m ? m[1].replace(/^\//, '') : 'word/document.xml';
}

// Проверка шаблона организации при загрузке: настоящий .docx без макросов, в пределах размеров. Ошибка — понятным текстом.
export function checkTemplate(buf, filename) {
  const bad = (msg) => new HttpError(400, 'bad_template', msg);
  if (!/\.docx$/i.test(String(filename ?? ''))) throw bad('Шаблон — файл Word .docx (не .doc, не .docm)');
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'empty_file', 'Файл пустой');
  if (buf.length > TEMPLATE_MAX_BYTES) throw bad(`Шаблон — не больше ${TEMPLATE_MAX_BYTES / 1024 / 1024} МБ`);
  let files;
  try { files = unzip(buf); } catch (e) { throw bad(`Файл не читается как Word .docx${e.message ? ` (${e.message})` : ''}`); }
  const types = files.find((f) => f.name === '[Content_Types].xml')?.data.toString('utf8');
  if (!types) throw bad('Файл не читается как Word .docx');
  if (/macroEnabled/i.test(types) || files.some((f) => /vbaProject\.bin$|vbaData\.xml$/i.test(f.name))) {
    throw bad('В шаблоне есть макросы — сохраните его как обычный документ Word (.docx)');
  }
  const doc = files.find((f) => f.name === mainPart(files));
  if (!doc || !/<w:body\b/.test(doc.data.toString('utf8')) || !/<\/w:body>/.test(doc.data.toString('utf8'))) throw bad('Файл не читается как Word .docx');
  return { marked: files.some((f) => f.name === doc.name && paraText(f.data.toString('utf8')).includes(TEMPLATE_MARK)) };
}

// ——— Архив ———

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не архив');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > UNZIP_MAX_ENTRIES) throw new Error('слишком много частей');
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('повреждён');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error('зашифрован');
    if (name.endsWith('/')) continue;
    if (name.includes('..') || name.startsWith('/')) throw new Error('неверное имя части');
    total += usize;
    if (usize === 0xffffffff || total > UNZIP_MAX_BYTES) throw new Error('слишком большой');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('повреждён');
    const from = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(from, from + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error('неизвестное сжатие');
    if (data.length !== usize) throw new Error('повреждён');
    out.push({ name, data });
  }
  return out;
}

// ZIP: XML сжимается (метод 8), остальное — как есть, если сжатие не помогает.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const packed = zlib.deflateRawSync(data);
    const method = packed.length < data.length ? 8 : 0;
    const body = method === 8 ? packed : data;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(0, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBuf, end]);
}
