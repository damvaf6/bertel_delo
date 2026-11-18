// Образцы акта осмотра и заключения — Word и PDF по четырём видам первого выпуска «Экспертизы» (задача штаба 41c17197).
// Проходит настоящую цепочку платформы на локальной базе: заявка → эксперт → осмотр по ссылке → черновик ИИ (поддельная
// модель) → правка эксперта → «Скачать Word» / «Скачать PDF», акт осмотра Word / PDF. Только вымышленные данные.
//   node tests/tools/doc-samples.mjs <папка>          (нужны PostgreSQL как для npm test и LibreOffice — soffice)
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, mkdtempSync } from 'node:fs';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

const OUT = path.resolve(process.argv[2] ?? 'test-results/doc-samples');

// Вымышленные заявки: номера телефонов +7999000xxxx, адреса и имена выдуманы.
const KINDS = [
  { id: 'realty', file: '1-nedvizhimost', title: 'Оценка квартиры (образец)', steps: 4, fields: {
    purpose: 'bank', bank: 'other', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Образцовая, д. 1, кв. 10',
    area: '54.3', rooms: 2, floor: '5 / 9' } },
  { id: 'vehicle', file: '2-transport', title: 'Оценка автомобиля (образец)', steps: 4, fields: {
    purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Образцовая Модель С', year: 2020, vin: 'XTA00000000000099',
    mileage: 64000 } },
  { id: 'car_damage', file: '3-ushcherb-dtp', title: 'Ущерб после ДТП (образец)', steps: 4, fields: {
    purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Образцовая Модель С', year: 2019,
    accident_date: '02.11.2026', accident_place: 'г. Москва, Образцовый пр-т, д. 5', damage: 'Передний бампер\nЛевая фара\nКапот',
    method: 'market', insurer: 'Образцовая страховая' } },
  { id: 'goods', file: '4-tovarovedcheskaya', title: 'Товароведческая экспертиза (образец)', steps: 3, fields: {
    purpose: 'court', region: 'moscow', subject: 'Велосипед: треснула рама через месяц после покупки', goods_kind: 'other',
    model: 'Образцовый велосипед 29', defects: 'Трещина рамы у каретки', questions: 'Есть ли у велосипеда недостатки? Каков их характер — производственный или эксплуатационный?' } },
];

// Текст эксперта вместо пометок «[заполнить: …]» — как будто эксперт уже поправил черновик.
const filled = (text) => text
  .replace(/\[описать по фото: ([^\]]+)\]/g, (_, s) => `На фото «${s}» видно: состояние удовлетворительное, видимых повреждений, кроме описанных ниже, нет (образец текста эксперта).`)
  .replace(/\[заполнить: расч[^\]]*\]/g, 'Расчёт приведён в таблице раздела; итоговая величина — 1 000 000 (один миллион) рублей 00 копеек (вымышленная сумма образца).')
  .replace(/\[заполнить[^\]]*\]/g, 'Текст раздела пишет эксперт — здесь образец: сведения изложены по материалам дела и результатам осмотра.');

function photo(dir, i) {
  const f = path.join(dir, `p${i}.jpg`);
  const colors = [['#c9d6e3', '#5b7083'], ['#e3dcc9', '#83705b'], ['#cfe3c9', '#5b8360'], ['#e3c9d6', '#835b70']][i % 4];
  execFileSync('convert', ['-size', '1200x900', `gradient:${colors[0]}-${colors[1]}`, '-quality', '70', f]);
  return readFileSync(f);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'delo-samples-'));
  const S = await startApp({ PDF_PROVIDER: 'soffice' });
  try {
    const owner = await login(S, '+79990009901');
    const disp = await login(S, '+79990009902');
    const spec = await login(S, '+79990009903');
    await setPlatformRole(S.sql, disp.user.id, 'dispatcher');
    await makeSpecialist(S.sql, spec.user.id, { permits: KINDS.map((k) => ['expertise', k.id]) });
    await owner.req('PATCH', '/api/me', { full_name: 'Образцов Заказчик Иванович' });
    await spec.req('PATCH', '/api/me', { full_name: 'Примерова Эксперт Петровна' });
    const step = async (c, o, to) => {
      const [cur] = await S.sql`select status from orders where id = ${o.id}`;
      const r = await c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
      if (r.status !== 200) throw new Error(`${to}: ${JSON.stringify(r.body)}`);
    };
    const get = async (c, p) => {
      const r = await fetch(S.base + p, { headers: { cookie: c.cookie } });
      if (r.status !== 200) throw new Error(`${p}: ${r.status} ${await r.text()}`);
      return Buffer.from(await r.arrayBuffer());
    };
    const report = [];
    for (const k of KINDS) {
      const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: k.id, title: k.title })).body.order;
      const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: k.fields });
      if (p.status !== 200) throw new Error(`${k.id}: ${JSON.stringify(p.body)}`);
      await step(owner, o, 'matching');
      await ensurePaid(S.sql, o.id);
      const off = await disp.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' });
      if (off.status !== 200) throw new Error(`offer ${k.id}: ${JSON.stringify(off.body)}`);
      await step(spec, o, 'in_work');
      // Осмотр по ссылке: владелец снимает первые шаги с геометкой.
      const link = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
      const token = link.body.path.split('#')[1];
      const steps = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body.steps.slice(0, k.steps);
      for (const [i, s] of steps.entries()) {
        const r = await client(S).req('POST', '/api/inspect/photos', photo(tmp, i), { raw: true, headers: {
          'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': s.id, 'x-lat': '55.7512', 'x-lon': '37.6184', 'x-accuracy': '12',
          'x-shot-at': new Date(Date.now() - (k.steps - i) * 60_000).toISOString() } });
        if (r.status !== 201) throw new Error(`фото ${k.id}/${s.id}: ${JSON.stringify(r.body)}`);
      }
      await client(S).req('POST', '/api/inspect/finish', {}, { headers: { 'x-inspect-token': token } });
      // Черновик ИИ → правка эксперта.
      const ai = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
      if (ai.status >= 300) throw new Error(`draft ${k.id}: ${JSON.stringify(ai.body)}`);
      const d = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft;
      const sv = await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: filled(d.body), from: d.id });
      if (sv.status >= 300) throw new Error(`save ${k.id}: ${JSON.stringify(sv.body)}`);
      const files = {
        [`${k.file}-akt-osmotra.docx`]: await get(spec, `/api/orders/${o.id}/inspection/act`),
        [`${k.file}-akt-osmotra.pdf`]: await get(spec, `/api/orders/${o.id}/inspection/act?format=pdf`),
        [`${k.file}-zaklyuchenie.docx`]: await get(spec, `/api/orders/${o.id}/draft/docx`),
        [`${k.file}-zaklyuchenie.pdf`]: await get(spec, `/api/orders/${o.id}/draft/docx?format=pdf`),
      };
      for (const [name, buf] of Object.entries(files)) await writeFile(path.join(OUT, name), buf);
      report.push(`${k.id}: ${Object.keys(files).join(', ')}`);
    }
    console.log(`Образцы — ${OUT}\n${report.join('\n')}`);
  } finally {
    await S.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
