// Настройки ядра — только из переменных окружения. Ключи и пароли в код не попадают.
// На stage/prod недопустимы: поддельные поставщики, база без проверки сертификата, служебные тестовые пути.

import { AI_DRIVERS } from './providers/ai.mjs';

const ENVS = ['test', 'dev', 'stage', 'prod'];

// Где возможен служебный вход тестовыми номерами. prod здесь не бывает — это проверяет tests/server/stage-login.test.mjs.
export const STAGE_LOGIN_ENVS = Object.freeze(['stage', 'test']);

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  const appEnv = env.APP_ENV || 'dev';
  if (!ENVS.includes(appEnv)) throw new ConfigError(`APP_ENV: одно из ${ENVS.join(', ')}`);
  const live = appEnv === 'stage' || appEnv === 'prod';

  const cfg = {
    appEnv,
    live,
    port: Number(env.PORT || 8080),
    databaseUrl: env.DATABASE_URL || '',
    // Без проверки сертификата база подключается только локально (тесты, разработка).
    dbSsl: env.DB_SSL === 'disable' ? 'disable' : 'verify',
    dbCaPath: env.DB_CA_PATH || '',
    appSecret: env.APP_SECRET || '',
    cookieSecure: env.COOKIE_SECURE !== '0',
    trustProxy: env.TRUST_PROXY === '1',
    // Адрес сайта для возврата со страницы оплаты ЮKassa (без «/» в конце). Пусто — относительный адрес (только поддельная оплата).
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    providers: {
      sms: env.SMS_PROVIDER || 'fake',
      call: env.CALL_PROVIDER || 'fake',
      storage: env.STORAGE_PROVIDER || 'memory',
      payments: env.PAYMENTS_PROVIDER || 'fake',
      ai: env.AI_PROVIDER || 'fake',
      mail: env.MAIL_PROVIDER || 'fake',
      // Электронная подпись заключения УКЭП (2.5): до решения Дамира о поставщике — только поддельная.
      sign: env.SIGN_PROVIDER || 'fake',
    },
    s3: {
      endpoint: env.S3_ENDPOINT || 'https://storage.yandexcloud.net',
      // Адрес для временных ссылок, если хранилище видно пользователю по другому адресу (MinIO в CI).
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || '',
      region: env.S3_REGION || 'ru-central1',
      bucket: env.S3_BUCKET || '',
      accessKeyId: env.S3_ACCESS_KEY || '',
      secretAccessKey: env.S3_SECRET_KEY || '',
      forcePathStyle: env.S3_PATH_STYLE === '1',
    },
    // ИИ: основная модель — AI_PROVIDER, запасная — AI_FALLBACK (пусто — без запасной). Ключи — из Lockbox через окружение.
    ai: {
      fallback: env.AI_FALLBACK || '',
      dailyLimit: Number(env.AI_DAILY_LIMIT || 50),
      yandex: {
        url: (env.AI_YANDEX_URL || 'https://llm.api.cloud.yandex.net/v1').replace(/\/+$/, ''),
        folder: env.AI_YANDEX_FOLDER || '',
        apiKey: env.AI_YANDEX_API_KEY || '',
        model: env.AI_YANDEX_MODEL || 'yandexgpt/latest',
      },
      gigachat: {
        authUrl: env.GIGACHAT_AUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
        url: (env.GIGACHAT_URL || 'https://gigachat.devices.sberbank.ru/api/v1').replace(/\/+$/, ''),
        authKey: env.GIGACHAT_AUTH_KEY || '',
        scope: env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
        model: env.GIGACHAT_MODEL || 'GigaChat-Pro',
      },
    },
    // Заявка по письму (1.9): особый адрес, на который присылают письма-заявки и с которого уходят ответы.
    mail: {
      inbox: (env.MAIL_INBOX_ADDRESS || 'zayavki@delo.test').trim().toLowerCase(),
      pollSec: Number(env.MAIL_POLL_SEC || 60),
    },
    // Мост CRM → Платформа (1.10): общий ключ подписи сообщений (пусто — мост выключен) и адрес CRM для ссылок «Открыть в CRM».
    crm: {
      bridgeSecret: env.CRM_BRIDGE_SECRET || '',
      url: (env.CRM_URL || '').replace(/\/+$/, ''),
    },
    // При старте контейнера (src/startup.mjs): обновить схему базы и проверить базу и хранилище файлов.
    startup: {
      migrate: env.MIGRATE_ON_START === '1',
      check: env.STARTUP_CHECK === '1',
    },
    // Служебные пути для автотестов (чтение вызовов поддельных поставщиков). Только APP_ENV=test.
    testControlToken: env.TEST_CONTROL_TOKEN || '',
    // Служебный вход тестовыми номерами +7999000xxxx на закрытой проверочной площадке (решение Дамира 02.10.2026).
    // Только APP_ENV=stage (и test — автотесты); на prod сервер с этим ключом не стартует.
    stageLoginKey: env.STAGE_LOGIN_KEY || '',
    // Лимит запросов входа с одного адреса за 10 минут. Менять — только APP_ENV=test (много входов в одном прогоне).
    authRateMax: env.AUTH_RATE_MAX ? Number(env.AUTH_RATE_MAX) : 30,
  };

  if (!cfg.databaseUrl) throw new ConfigError('DATABASE_URL не задан');
  if (cfg.appSecret.length < 32) {
    if (live) throw new ConfigError('APP_SECRET: не короче 32 символов');
    cfg.appSecret = 'local-only-secret-not-for-stage-or-prod-000';
  }
  if (env.AUTH_RATE_MAX && appEnv !== 'test') throw new ConfigError('AUTH_RATE_MAX допустим только при APP_ENV=test');
  if (!Number.isInteger(cfg.authRateMax) || cfg.authRateMax < 1) throw new ConfigError('AUTH_RATE_MAX: целое число от 1');
  if (cfg.testControlToken && appEnv !== 'test') throw new ConfigError('TEST_CONTROL_TOKEN допустим только при APP_ENV=test');
  if (cfg.stageLoginKey && !STAGE_LOGIN_ENVS.includes(appEnv)) throw new ConfigError('STAGE_LOGIN_KEY допустим только на проверочной площадке (APP_ENV=stage)');
  if (cfg.stageLoginKey && cfg.stageLoginKey.length < 32) throw new ConfigError('STAGE_LOGIN_KEY: не короче 32 символов');
  if (cfg.providers.storage === 's3' && !cfg.s3.bucket) throw new ConfigError('S3_BUCKET не задан');

  // Модели ИИ — только из списка (зарубежные в контуре с персональными данными запрещены уставом).
  for (const [name, driver] of [['AI_PROVIDER', cfg.providers.ai], ['AI_FALLBACK', cfg.ai.fallback]]) {
    if (name === 'AI_FALLBACK' && !driver) continue;
    if (!AI_DRIVERS.includes(driver)) throw new ConfigError(`${name}: одно из ${AI_DRIVERS.join(', ')}`);
    if (driver === 'yandexgpt' && (!cfg.ai.yandex.apiKey || !cfg.ai.yandex.folder)) throw new ConfigError('YandexGPT: нужны AI_YANDEX_API_KEY и AI_YANDEX_FOLDER');
    if (driver === 'gigachat' && !cfg.ai.gigachat.authKey) throw new ConfigError('GigaChat: нужен GIGACHAT_AUTH_KEY');
  }
  if (cfg.ai.fallback && cfg.ai.fallback === cfg.providers.ai) throw new ConfigError('AI_FALLBACK совпадает с AI_PROVIDER');
  if (!Number.isInteger(cfg.ai.dailyLimit) || cfg.ai.dailyLimit < 1) throw new ConfigError('AI_DAILY_LIMIT: целое число от 1');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.mail.inbox)) throw new ConfigError('MAIL_INBOX_ADDRESS: адрес почты');
  if (cfg.providers.mail !== 'fake' && !env.MAIL_INBOX_ADDRESS) throw new ConfigError('MAIL_INBOX_ADDRESS нужен для настоящей почты');
  if (!Number.isInteger(cfg.mail.pollSec) || cfg.mail.pollSec < 10) throw new ConfigError('MAIL_POLL_SEC: целое число от 10');
  if (cfg.crm.bridgeSecret && cfg.crm.bridgeSecret.length < 32) throw new ConfigError('CRM_BRIDGE_SECRET: не короче 32 символов');
  if (cfg.crm.url && !(live ? /^https:\/\/[^\s/]+/ : /^https?:\/\/[^\s/]+/).test(cfg.crm.url)) throw new ConfigError(`CRM_URL: адрес ${live ? 'https://…' : 'http(s)://…'}`);
  if (cfg.providers.payments !== 'fake' && !/^https:\/\//.test(cfg.publicUrl)) throw new ConfigError('PUBLIC_URL (https://…) нужен для настоящей оплаты');
  if (live) {
    if (cfg.dbSsl === 'disable') throw new ConfigError('На stage/prod база только с проверкой сертификата');
    if (!cfg.cookieSecure) throw new ConfigError('На stage/prod cookie только Secure');
    if (cfg.providers.storage !== 's3') throw new ConfigError('На stage/prod файлы только в S3 (Yandex Object Storage)');
  }
  // На stage поддельные СМС/звонок/оплата/ИИ/почта/подпись допустимы (тестовые данные); на prod — нет.
  if (appEnv === 'prod') {
    for (const [name, driver] of Object.entries(cfg.providers)) {
      if (driver === 'fake') throw new ConfigError(`На prod поставщик «${name}» не может быть поддельным`);
    }
    if (cfg.ai.fallback === 'fake') throw new ConfigError('На prod запасная модель ИИ не может быть поддельной');
  }
  return cfg;
}
