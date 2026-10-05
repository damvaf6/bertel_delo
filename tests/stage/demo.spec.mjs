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
});
