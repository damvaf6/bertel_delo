// Точка запуска ядра (в контейнере и локально).
import { loadConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { createProviders } from './providers/index.mjs';
import { createApp } from './app.mjs';
import { deliverPending } from './notify/notify.mjs';
import { deliverMail } from './mail/outbox.mjs';
import { processInbound, receiveMail } from './mail/inbound.mjs';

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

// Заявки по письму (1.9): забрать новые письма, разобрать очередь, отправить ответы — раз в MAIL_POLL_SEC секунд.
const deps = { cfg, sql, providers, registry: app.locals.registry };
let mailBusy = false;
const mailSweep = setInterval(async () => {
  if (mailBusy) return;
  mailBusy = true;
  try {
    await receiveMail(deps);
    await processInbound(deps);
    await deliverMail(sql, providers, cfg);
  } catch (e) { console.error('письма:', e?.message || e); } finally { mailBusy = false; }
}, cfg.mail.pollSec * 1000);
mailSweep.unref();

function stop() {
  clearInterval(sweep);
  clearInterval(mailSweep);
  server.close(() => sql.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
