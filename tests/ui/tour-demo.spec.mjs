// Задача 2.51: демо-площадка и экскурсия на 10 минут — на телефоне 412×915 против стенда или контейнера CI.
// Наполнение — tests/tools/demo-seed.mjs (вход кодом из поддельного СМС), сценарий и снимки — tests/tools/demo-tour.mjs
// (test-results/demo/screens/demo-NN.png). На площадке то же самое — tests/stage/demo.spec.mjs.
// Файл назван так, чтобы идти после остальных проверок телефона: демо-эксперты не попадают в их подбор.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { seedDemo, codeLogin, DEMO_CASES } from '../tools/demo-seed.mjs';
import { demoTour, DEMO_TOUR } from '../tools/demo-tour.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const ADMIN = '+79990009510';

test('демо-площадка: наполнение и экскурсия на 10 минут', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const login = codeLogin(baseURL, CONTROL);
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("insert into users (phone, platform_role) values ($1, 'admin') on conflict (phone) do update set platform_role = 'admin'", [ADMIN]); } finally { await c.end(); }

  const r = await seedDemo({ base: baseURL, login, adminPhone: ADMIN });
  expect(r.created).toBe(true);
  expect(Object.keys(r.cases)).toHaveLength(DEMO_CASES.length);
  const shots = await demoTour({ browser, baseURL, sessions: r.sessions, cases: r.cases, orgs: r.orgs, base: 'local' });
  expect(shots).toHaveLength(DEMO_TOUR.length);
});
