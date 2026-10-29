// Замечания к сданному отчёту пунктами (задача 2.432): текст замечаний (что написал заказчик и что в файле замечаний банка
// или суда) делится на отдельные пункты. Делит модель ИИ (подсказка — remarkMessages); её ответ чистится здесь же, а если
// модель вернула не то — пункты по нумерации текста (splitRemarks). Пункты только предлагаются: эксперт правит, удаляет,
// добавляет свои и сам отмечает у каждого «исправлено в отчёте» или «пояснение без правки».

export const ITEM_MAX = 1000;
export const ITEMS_MAX = 50;
export const SOURCE_MAX = 30_000; // столько знаков файла замечаний уходит модели
export const RESOLUTIONS = ['fixed', 'explained'];
export const RESOLUTION_NAME = { fixed: 'исправлено в отчёте', explained: 'пояснение без правки' };

// Начало пункта: «1.», «1)», «п. 2», «Пункт 3.», «Замечание 4:», маркер «-», «•», «—».
const POINT_RE = /^\s*(?:(?:п\.|пункт|замечание)\s*)?(?:\d{1,3}(?:\.\d{1,2})*[.)]|\d{1,3}\s*[:\-–—]|[-•–—*])\s+/iu;
const NUM_HEAD_RE = /^\s*(?:п\.|пункт|замечание)\s*\d{1,3}\s*[.:)]?\s*/iu;

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clipItem = (s) => (s.length > ITEM_MAX ? `${s.slice(0, ITEM_MAX - 1)}…` : s);

// Пункты одного текста: нумерованные строки — каждая с продолжением до следующей; без нумерации — абзацы через пустую строку;
// один абзац — целиком одним пунктом. Шапку перед первым пунктом («Замечания к отчёту № …:») не берём, если пункты нашлись.
export function splitRemarks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const points = [];
  let cur = null;
  for (const line of lines) {
    if (POINT_RE.test(line) || NUM_HEAD_RE.test(line)) {
      if (cur) points.push(cur);
      cur = line.replace(POINT_RE, '').replace(NUM_HEAD_RE, '');
    } else if (cur !== null) {
      if (line.trim()) cur += ` ${line}`;
    }
  }
  if (cur) points.push(cur);
  let out = points.map(tidy).filter(Boolean);
  if (out.length < 2) out = String(text ?? '').split(/\n\s*\n/).map(tidy).filter(Boolean);
  return cleanItems(out);
}

// Пункты из ответа модели или из ввода: строки без пустых и повторов, каждая — не длиннее ITEM_MAX, всего — не больше ITEMS_MAX.
export function cleanItems(list) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = clipItem(tidy(typeof v === 'string' ? v : v?.text));
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= ITEMS_MAX) break;
  }
  return out;
}

// Что уходит модели: текст заказчика и текст файла замечаний. Модель только делит на пункты — слово в слово, не отвечает
// на замечания и не придумывает своих.
export function remarkMessages({ text, file }) {
  return [
    { role: 'system', content: 'Ты помогаешь эксперту-оценщику. Банк или суд прислал замечания к отчёту об оценке. Раздели '
      + 'замечания на отдельные пункты: один пункт — одно требование или вопрос. Пиши слово в слово, как в замечаниях, без '
      + 'номеров пунктов. Не отвечай на замечания, не оценивай их и не добавляй своих. Шапку, подписи и реквизиты письма не '
      + 'бери. Ответ — только JSON: {"items": ["…", "…"]}.' },
    { role: 'user', content: `ЗАМЕЧАНИЯ (со слов заказчика):\n${text || '—'}\n\nФАЙЛ ЗАМЕЧАНИЙ:\n${file ? file.slice(0, SOURCE_MAX) : '—'}` },
  ];
}

// Поддельная модель: пункты по нумерации — сначала из файла замечаний, нет пунктов в файле — из текста заказчика.
export function fakeRemarkItems(prompt) {
  const [head, file = ''] = String(prompt).split('ФАЙЛ ЗАМЕЧАНИЙ:\n');
  const said = head.replace(/^ЗАМЕЧАНИЯ \(со слов заказчика\):\n/, '').trim();
  const fromFile = file.trim() && file.trim() !== '—' ? splitRemarks(file) : [];
  return JSON.stringify({ items: fromFile.length ? fromFile : splitRemarks(said) });
}
