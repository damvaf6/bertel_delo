// Экскурсия по кабинетам → один PDF (решение Дамира 03.10.2026, пункт а): снимки телефона из tests/stage/tour.spec.mjs
// и подписи к ним. Собирается браузером Playwright из страницы с картинками, без внешних ресурсов.
//   node tests/tools/tour-pdf.mjs [папка с tour.json и screens/] [файл.pdf]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const dir = path.resolve(process.argv[2] || 'test-results');
const out = path.resolve(process.argv[3] || path.join(dir, 'Экскурсия по кабинетам.pdf'));
const tour = JSON.parse(fs.readFileSync(path.join(dir, 'tour.json'), 'utf8'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = new Date(tour.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const where = tour.base === 'stage' ? 'проверочная площадка в Яндекс Облаке' : 'локальный стенд';
const order = [...new Set(tour.shots.map((s) => s.cabinet))];

// Длинные снимки режем на части высотой с экран, чтобы текст на них оставался читаемым: ширина картинки на листе —
// IMG_W мм, часть — не выше PART_H мм; каждая часть — свой лист с той же подписью («продолжение»).
const IMG_W = 104;
const PART_H = 214;
const size = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const pages = tour.shots.map((s, i) => {
  const buf = fs.readFileSync(path.join(dir, 'screens', s.file));
  const { w, h } = size(buf);
  const img = buf.toString('base64');
  const k = IMG_W / w; // мм на точку
  const partPx = Math.floor(PART_H / k);
  const parts = Math.max(1, Math.ceil((h - partPx * 0.15) / partPx));
  return Array.from({ length: parts }, (_, p) => {
    const top = p * partPx;
    const hh = Math.min(partPx, h - top);
    return `<section class="shot">
    <div class="head"><span class="cab">${esc(s.cabinet)}</span><span class="n">${i + 1} из ${tour.shots.length}</span></div>
    <h2>${esc(s.title)}${parts > 1 ? ` <span class="muted">(${p + 1}/${parts})</span>` : ''}</h2>
    <div class="frame" style="width:${IMG_W}mm;height:${(hh * k).toFixed(2)}mm"><img style="width:${IMG_W}mm;margin-top:-${(top * k).toFixed(2)}mm" src="data:image/png;base64,${img}"></div>
    <p class="cap">${esc(s.caption)}</p>
  </section>`;
  }).join('\n');
}).join('\n');

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 12mm 14mm; }
  body { font-family: "DejaVu Sans", Arial, sans-serif; color: #1c2430; margin: 0; }
  .title { page-break-after: always; padding-top: 40mm; }
  .title h1 { font-size: 26pt; margin: 0 0 6mm; }
  .title p { font-size: 12pt; line-height: 1.5; margin: 0 0 3mm; }
  .title ul { font-size: 12pt; line-height: 1.6; }
  .muted { color: #5b6573; }
  .shot { page-break-after: always; display: flex; flex-direction: column; align-items: center; height: 270mm; }
  .head { width: 100%; display: flex; justify-content: space-between; font-size: 10pt; color: #5b6573; }
  .cab { font-weight: bold; color: #1f4e8c; }
  h2 { font-size: 15pt; margin: 2mm 0 3mm; width: 100%; }
  .frame { overflow: hidden; border: 1px solid #c9d1dc; border-radius: 3mm; }
  .frame img { display: block; }
  .cap { font-size: 12pt; line-height: 1.45; margin: 4mm 0 0; width: 100%; }
</style></head><body>
  <section class="title">
    <h1>БЕРТЕЛ Дело — экскурсия по кабинетам</h1>
    <p>Снимки экрана телефона (412×915), ${esc(where)}. Снято ${esc(day)} по Москве.</p>
    <p class="muted">Только тестовые данные: номера +7 999 000-xx-xx, вымышленные марка машины, VIN и отчёт. Оплата и подпись — тестовые.</p>
    <p>Порядок: заявка заказчика → цена и подбор у диспетчера → работа эксперта (осмотр, черновик от ИИ, ИИ-проверка, подпись) →
      подпись руководителя организации → проверка диспетчером → результат у заказчика → выплата эксперту.</p>
    <ul>${order.map((c) => `<li>${esc(c)} — ${tour.shots.filter((s) => s.cabinet === c).length} сн.</li>`).join('')}</ul>
  </section>
  ${pages}
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: out, format: 'A4', printBackground: true });
await browser.close();
console.log(out);
