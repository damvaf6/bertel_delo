// Открытая демо-площадка на телефоне 412×915: DEMO_BASE_URL — адрес в облаке (workflow «Demo (Yandex Cloud)»);
// без него — локальный стенд в режиме демо (tests/demo/stand.mjs).
import { defineConfig } from '@playwright/test';

const STAND = 'http://127.0.0.1:8789';

export default defineConfig({
  testDir: 'tests/demo',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: process.env.DEMO_BASE_URL || STAND,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.DEMO_BASE_URL ? undefined : {
    command: 'node tests/demo/stand.mjs',
    url: `${STAND}/api/demo/roles`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
