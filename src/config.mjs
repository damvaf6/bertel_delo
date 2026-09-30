// Настройки ядра — только из переменных окружения. Ключи и пароли в код не попадают.
// На stage/prod недопустимы: поддельные поставщики, база без проверки сертификата, служебные тестовые пути.

const ENVS = ['test', 'dev', 'stage', 'prod'];

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
    providers: {
      sms: env.SMS_PROVIDER || 'fake',
      storage: env.STORAGE_PROVIDER || 'memory',
      payments: env.PAYMENTS_PROVIDER || 'fake',
      ai: env.AI_PROVIDER || 'fake',
      mail: env.MAIL_PROVIDER || 'fake',
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
    // Служебные пути для автотестов (чтение вызовов поддельных поставщиков). Только APP_ENV=test.
    testControlToken: env.TEST_CONTROL_TOKEN || '',
  };

  if (!cfg.databaseUrl) throw new ConfigError('DATABASE_URL не задан');
  if (cfg.appSecret.length < 32) {
    if (live) throw new ConfigError('APP_SECRET: не короче 32 символов');
    cfg.appSecret = 'local-only-secret-not-for-stage-or-prod-000';
  }
  if (cfg.testControlToken && appEnv !== 'test') throw new ConfigError('TEST_CONTROL_TOKEN допустим только при APP_ENV=test');
  if (cfg.providers.storage === 's3' && !cfg.s3.bucket) throw new ConfigError('S3_BUCKET не задан');

  if (live) {
    if (cfg.dbSsl === 'disable') throw new ConfigError('На stage/prod база только с проверкой сертификата');
    if (!cfg.cookieSecure) throw new ConfigError('На stage/prod cookie только Secure');
    if (cfg.providers.storage !== 's3') throw new ConfigError('На stage/prod файлы только в S3 (Yandex Object Storage)');
  }
  // На stage поддельные СМС/оплата/ИИ/почта допустимы (тестовые данные); на prod — нет.
  if (appEnv === 'prod') {
    for (const [name, driver] of Object.entries(cfg.providers)) {
      if (driver === 'fake') throw new ConfigError(`На prod поставщик «${name}» не может быть поддельным`);
    }
  }
  return cfg;
}
