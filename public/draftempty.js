// Пустые разделы черновика (2.177): перед сборкой Word эксперт видит, какие разделы ещё без текста, и одним нажатием
// переходит к разделу. Раздел — заголовок «#…###» и всё до следующего заголовка (как при сборке Word, src/docs/docx.mjs).
// Пустой — нет ни одной строки текста, кроме пометок «[заполнить…]» / «[описать…]». Заголовок, сразу за которым идут
// его подразделы («## 5. Расчёт» → «### 5.1 …»), пустым не считается: текст — в подразделах; подраздел без текста — пустой.
// Без импортов: тот же модуль проверяется серверными тестами (tests/server/draft.test.mjs).
const GAP = /\[(?:заполнить|описать)[^\]]*\]/gi;
const HEAD = /^(#{1,3})\s*(.+)$/;

export function emptySections(body) {
  const lines = String(body ?? '').split('\n');
  const heads = [];
  let at = 0;
  for (const raw of lines) {
    const h = raw.match(HEAD);
    if (h) heads.push({ level: h[1].length, title: h[2].trim(), at, end: at + raw.length, text: false });
    else if (heads.length && /[\p{L}\p{N}]/u.test(raw.replace(GAP, ''))) heads[heads.length - 1].text = true;
    at += raw.length + 1;
  }
  // Текста до следующего заголовка нет: если он глубже — это подраздел, и раздел не пустой.
  return heads
    .filter((h, i) => !h.text && !(heads[i + 1]?.level > h.level))
    .map(({ title, at: start, end }) => ({ title, at: start, end }));
}
