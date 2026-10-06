// Поиск по своим делам одной строкой (2.73): номер, адрес, вид услуги, заказчик, эксперт — что уже есть в списке.
// Ищется по полученному списку, на сервер ничего не уходит. Каждое слово запроса должно найтись; регистр, «ё»
// и знаки препинания не важны: «лесная 2», «№ 1a2b», «ковалева» найдут своё.
export const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[№.,;:«»"'()/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();

// Окончания не мешают (2.73): у длинного слова из одних букв последние две буквы отбрасываются — «участок» найдёт
// «участка», «одинцовский» — «Одинцовский г. о.». Номера и слова с цифрами ищутся как есть.
const stem = (w) => (w.length >= 6 && /^\p{L}+$/u.test(w) ? w.slice(0, -2) : w);

// «Подходит ли строка» для запроса; пустой запрос — подходит всё.
export function matcher(query) {
  const words = norm(query).split(' ').filter(Boolean).map(stem);
  return (hay) => { const h = norm(hay); return words.every((w) => h.includes(w)); };
}

// Строка поиска: на телефоне «Найти» на клавиатуре прячет клавиатуру — список виден целиком.
export function wireSearch(input, onChange) {
  input.addEventListener('input', onChange);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
}
