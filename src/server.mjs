// Точка запуска ядра (в контейнере и локально).
import { loadConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { createProviders } from './providers/index.mjs';
import { createApp } from './app.mjs';
import { deliverPending } from './notify/notify.mjs';

const cfg = loadConfig();
const sql = createDb(cfg);
const providers = createProviders(cfg);
const app = createApp({ cfg, sql, providers });

const server = app.listen(cfg.port, () => console.log(`БЕРТЕЛ Дело · ядро · ${cfg.appEnv} · порт ${cfg.port}`));

// Повтор неотправленных СМС-уведомлений раз в минуту (первая попытка — сразу после операции, src/http/router.mjs).
const sweep = setInterval(() => {
  deliverPending(sql, providers).catch((e) => console.error('уведомления:', e?.message || e));
}, 60_000);
sweep.unref();

function stop() {
  clearInterval(sweep);
  server.close(() => sql.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
