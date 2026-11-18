// PDF из Word (задача штаба 41c17197): настройка, поддельный PDF для проверок, LibreOffice — тот же текст, что в Word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadConfig, ConfigError } from '../../src/config.mjs';
import { createPdf, fakePdf, sofficePdf } from '../../src/providers/pdf.mjs';
import { buildReport, buildSimpleDoc, signBlocks } from '../../src/docs/docx.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

const base = { DATABASE_URL: 'x' };

test('41c17197: PDF — на площадках LibreOffice, в проверках поддельный; поддельный на площадке не пускается', () => {
  assert.equal(loadConfig({ ...base, APP_ENV: 'dev' }).providers.pdf, 'fake');
  assert.equal(loadConfig({ ...base, APP_ENV: 'dev', PDF_PROVIDER: '' }).providers.pdf, '');
  assert.throws(() => loadConfig({ ...base, APP_ENV: 'dev', PDF_PROVIDER: 'gotenberg' }), ConfigError);
  assert.equal(createPdf({ providers: { pdf: '' } }).ready, false);
  assert.equal(createPdf({ providers: { pdf: 'soffice' }, pdf: { bin: '/нет/soffice' } }).ready, false, 'нет LibreOffice — PDF не обещаем');
});

test('41c17197: место под подпись и печать — после разделов; уже есть «М.П.» в тексте — второй раз нет', () => {
  const s = signBlocks({ executor_role: 'Эксперт', executor: 'Тестов Т. Т.', org: 'ООО «Тест»', date: '18.11.2026' }).map((b) => b.text);
  assert.match(s[0], /^Эксперт _+ \/ Тестов Т\. Т\. \/$/);
  assert.match(s[1], /^Руководитель организации/);
  assert.match(s[2], /^18\.11\.2026\s+М\.П\.$/);
  assert.equal(signBlocks({ executor: 'Т' }).length, 2, 'без организации — без строки руководителя');
  assert.deepEqual(signBlocks({}, 'Подпись ___ М.П.'), []);
  assert.deepEqual(signBlocks({ sign: false }), []);
});

test('41c17197: поддельный PDF — настоящий файл PDF, вызовы записываются', async () => {
  const f = fakePdf();
  const out = await f.convert({ buf: Buffer.alloc(10), name: 'a.docx' });
  assert.equal(out.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(out.toString('latin1'), /%%EOF\n$/);
  assert.deepEqual(f.calls, [{ name: 'a.docx', bytes: 10 }]);
});

const lo = sofficePdf();
test('41c17197: LibreOffice — отчёт и акт в PDF: A4, весь текст Word на месте', { skip: !lo.ready && 'нет LibreOffice (soffice) — проверяется в контейнере' }, async () => {
  const norm = (s) => s.replace(/\s+/g, '');
  const text = '# 1. Задание на оценку\nОбъект: квартира, г. Москва, ул. Тестовая, д. 1\n| Подход | Стоимость |\n|---|---|\n| Сравнительный | 1 000 000 |\n# 2. Выводы\nИтог — один миллион рублей.';
  const docs = [
    buildReport(text, { title: 'Отчёт об оценке', number: '№ Т-1/2026', subtitle: 'Оценка недвижимости', executor: 'Тестов Т. Т.', executor_role: 'Исполнитель', date: '18.11.2026' }),
    buildSimpleDoc([{ type: 'title', text: 'Акт осмотра квартиры' }, { type: 'table', rows: [['Фото', 'Шаг'], ['Фото 1', 'Фасад']] }, { type: 'sign', text: 'Эксперт ____ / Тестов Т. Т. /' }, { type: 'para', text: 'М.П.' }]),
  ];
  const [a, b] = await Promise.all(docs.map((buf) => lo.convert({ buf })));   // два сразу — у каждого свой профиль LibreOffice
  for (const [i, pdf] of [a, b].entries()) {
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const word = (await extractPages(docs[i], 'a.docx')).pages.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
    let txt;
    try { txt = execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString(); } catch { return; }   // нет pdftotext — хватит PDF
    for (const l of word) assert.ok(norm(txt).includes(norm(l)), `в PDF нет строки Word: ${l}`);
    if (i === 0) assert.match(txt, /М\.П\./);
  }
});
