// Проверка интерфейса на телефоне: 412×915 (Android-телефон Дамира), Chromium.
// UI_BASE_URL задан — проверяется уже запущенный контейнер (CI); иначе поднимается локальный стенд.
import { defineConfig } from '@playwright/test';

const STAND = 'http://127.0.0.1:8788';

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 60_000,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/report' }]],
  outputDir: 'test-results/artifacts',
  globalSetup: './tests/ui/global-setup.mjs',
  use: {
    baseURL: process.env.UI_BASE_URL || STAND,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    acceptDownloads: true,
    // Без UTF-8 в окружении Chromium заменяет русские имена скачанных файлов на «download».
    launchOptions: { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.UI_BASE_URL ? undefined : {
    command: 'node tests/ui/stand.mjs',
    url: `${STAND}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
