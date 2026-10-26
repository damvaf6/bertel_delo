// Поиск по своим делам одной строкой (2.73): номер, адрес, вид услуги, заказчик, эксперт — что уже есть в списке.
// Ищется по полученному списку, на сервер ничего не уходит. Каждое слово запроса должно найтись; регистр, «ё»
// и знаки препинания не важны: «лесная 2», «№ 1a2b», «ковалева» найдут своё.
export const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[№.,;:«»"'()/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();

// Окончания не мешают (2.73): у длинного слова из одних букв последние две буквы отбрасываются — «участок» найдёт
// «участка», «одинцовский» — «Одинцовский г. о.». Номера и слова с цифрами ищутся как есть.
const stem = (w) => (w.length >= 6 && /^\p{L}+$/u.test(w) ? w.slice(0, -2) : w);

// Номер дела набран русскими буквами (2.165): «№ 1А2В» с похожими буквами или «1ф2и» — забыли переключить клавиатуру.
// В номере только цифры и латинские a–f; слово с цифрой ищется и как есть, и в обоих прочтениях — «2а» в адресе находится.
const LOOK = { а: 'a', в: 'b', с: 'c', е: 'e' };
const KEYS = { ф: 'a', и: 'b', с: 'c', в: 'd', у: 'e', а: 'f' };
const spell = (w, map) => [...w].map((ch) => map[ch] ?? ch).join('');
const variants = (w) => (/\d/.test(w) && /[а-я]/.test(w) ? [...new Set([w, spell(w, LOOK), spell(w, KEYS)])] : [w]);

// «Подходит ли строка» для запроса; пустой запрос — подходит всё.
export function matcher(query) {
  const words = norm(query).split(' ').filter(Boolean).map(stem).map(variants);
  return (hay) => { const h = norm(hay); return words.every((vs) => vs.some((w) => h.includes(w))); };
}

// Номер отчёта (2.417): каждая часть запроса — целой частью номера («14» найдёт «14/2026» и «В-14», но не «140/2026»);
// похожие латинские буквы — как русские («B-14» — «В-14»). Так же ищет сервер — `numberMatch` в src/orgs/registry.mjs.
const LATIN = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const numParts = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[a-z]/g, (ch) => LATIN[ch] ?? ch)
  .split(/[^0-9a-zа-я]+/).filter(Boolean);
export function numberMatch(q, number) {
  const w = numParts(q);
  const parts = numParts(number);
  return w.length > 0 && w.some((x) => /\d/.test(x)) && w.every((x) => parts.includes(x));
}

// Строка поиска: на телефоне «Найти» на клавиатуре прячет клавиатуру — список виден целиком.
export function wireSearch(input, onChange) {
  input.addEventListener('input', onChange);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
}
