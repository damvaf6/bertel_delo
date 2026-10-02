// Проверка на адресе контура stage после выкладки (workflow Deploy core): телефон 412×915, Chromium.
import { defineConfig } from '@playwright/test';

if (!process.env.UI_BASE_URL) throw new Error('UI_BASE_URL — адрес контура stage');

export default defineConfig({
  testDir: 'tests/stage',
  timeout: 60_000,
  // Облако отвечает медленнее локального стенда: ждём появления на экране до 15 с.
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: process.env.UI_BASE_URL,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    acceptDownloads: true,
    // Без UTF-8 в окружении Chromium заменяет русские имена скачанных файлов на «download».
    launchOptions: { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } },
    screenshot: 'only-on-failure',
  },
});
