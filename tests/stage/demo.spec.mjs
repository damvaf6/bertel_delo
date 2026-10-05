// Демо-площадка для показа (задача 2.51) — на адресе контура stage: наполнение обезличенными делами по всем видам
// экспертизы и оценки (tests/tools/demo-seed.mjs, служебный вход тестовыми номерами +7 999 000-1x-xx) и экскурсия
// на 10 минут со снимками телефона 412×915 (tests/tools/demo-tour.mjs → test-results/demo, PDF — в workflow).
// Только по просьбе (DEMO=1, workflow Deploy core с отметкой «Демо»). Повторный запуск дел не дублирует.
import { test, expect } from '@playwright/test';
import { seedDemo, stageLogin, DEMO_CASES } from '../tools/demo-seed.mjs';
import { demoTour, DEMO_TOUR } from '../tools/demo-tour.mjs';

const DEMO = process.env.DEMO === '1';
const TOKEN = process.env.STAGE_INVOKE_TOKEN;
const LOGIN_KEY = process.env.STAGE_LOGIN_KEY;
const ADMIN = process.env.STAGE_ADMIN_PHONE;

test('демо-площадка: наполнение и экскурсия на 10 минут', async ({ browser, baseURL }) => {
  test.skip(!DEMO, 'демо — только по просьбе (DEMO=1)');
  test.setTimeout(600_000);
  if (!TOKEN || !LOGIN_KEY || !/^\+7999000\d{4}$/.test(ADMIN || '')) throw new Error('нужны STAGE_INVOKE_TOKEN, STAGE_LOGIN_KEY, STAGE_ADMIN_PHONE');
  const headers = { authorization: `Bearer ${TOKEN}` };
  const r = await seedDemo({ base: baseURL, headers, login: stageLogin(baseURL, headers, LOGIN_KEY), adminPhone: ADMIN, log: (m) => console.log(`демо: ${m}`) });
  expect(Object.keys(r.cases)).toHaveLength(DEMO_CASES.length);
  const shots = await demoTour({ browser, baseURL, headers, sessions: r.sessions, cases: r.cases, orgs: r.orgs, base: 'stage' });
  expect(shots).toHaveLength(DEMO_TOUR.length);

  // 2.55: журнал и архив дела в облаке — заказчик закрытого дела (файлы — из хранилища Яндекса).
  const as = (k) => ({ ...headers, cookie: r.sessions[k] });
  const j = await (await fetch(`${baseURL}/api/orders/${r.cases.flat}/journal`, { headers: as('petrov') })).json();
  expect(j.journal.some((x) => x.what === 'Создана заявка' && x.who === 'Вы')).toBe(true);
  const z = await fetch(`${baseURL}/api/orders/${r.cases.flat}/export`, { headers: as('petrov') });
  expect(z.status).toBe(200);
  const zip = Buffer.from(await z.arrayBuffer());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.includes(Buffer.from('Документы/Выписка ЕГРН.pdf'))).toBe(true);
  // 2.54: сообщение о проблеме записывается и видно диспетчеру.
  const text = `Проверка площадки ${Date.now()}`;
  const p = await fetch(`${baseURL}/api/problems`, { method: 'POST', headers: { ...as('sidorova'), 'x-delo-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text, place: '#help' }) });
  expect(p.status).toBe(201);
  const list = await (await fetch(`${baseURL}/api/problems`, { headers: as('dispatcher') })).json();
  expect(list.problems.some((x) => x.text === text && x.place === '#help')).toBe(true);
  const close = await fetch(`${baseURL}/api/problems/${(await p.json()).id}/close`, { method: 'POST', headers: { ...as('dispatcher'), 'x-delo-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ note: 'проверка площадки' }) });
  expect(close.status).toBe(200);
});
