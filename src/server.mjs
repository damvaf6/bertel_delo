// Точка запуска ядра (в контейнере и локально).
import { loadConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { createProviders } from './providers/index.mjs';
import { createApp } from './app.mjs';
import { deliverPending } from './notify/notify.mjs';
import { remindDeadlines } from './notify/reminders.mjs';
import { remindDossier } from './dossier/dossier.mjs';
import { remindSilentInspections } from './ops/inspect-ops.mjs';
import { remindNotes } from './ops/note-ops.mjs';
import { sendMorning, sendOrgMorning } from './notify/morning.mjs';
import { deliverMail } from './mail/outbox.mjs';
import { processInbound, receiveMail } from './mail/inbound.mjs';
import { startupSteps } from './startup.mjs';

const cfg = loadConfig();
const sql = createDb(cfg);
const providers = createProviders(cfg);
const app = createApp({ cfg, sql, providers });

// Схема и проверка базы и файлов — до приёма запросов; ошибка — контейнер не стартует (видно в журнале облака).
try {
  await startupSteps({ cfg, sql, providers });
} catch (e) {
  console.error('запуск остановлен:', e?.message || e);
  process.exit(1);
}

const server = app.listen(cfg.port, () => console.log(`БЕРТЕЛ Дело · ядро · ${cfg.appEnv} · порт ${cfg.port}`));

// Повтор неотправленных СМС-уведомлений раз в минуту (первая попытка — сразу после операции, src/http/router.mjs);
// там же — напоминания о сроках (2.13) и о сроках документов досье (2.14), о ссылке осмотра без фото (2.85), по заметкам эксперта к делу (2.115), каждое один раз;
// утренняя сводка эксперту «На сегодня» (2.119) и руководителю «На сегодня по организации» (2.121) — раз в день после 8:00 по Москве.
const sweep = setInterval(() => {
  remindDeadlines(sql)
    .catch((e) => console.error('напоминания о сроках:', e?.message || e))
    .then(() => remindDossier(sql))
    .catch((e) => console.error('напоминания по досье:', e?.message || e))
    .then(() => remindSilentInspections(sql))
    .catch((e) => console.error('напоминания об осмотре:', e?.message || e))
    .then(() => remindNotes(sql))
    .catch((e) => console.error('напоминания по заметкам:', e?.message || e))
    .then(() => sendMorning(sql))
    .catch((e) => console.error('утренняя сводка:', e?.message || e))
    .then(() => sendOrgMorning(sql, app.locals.registry))
    .catch((e) => console.error('утренняя сводка руководителю:', e?.message || e))
    .then(() => deliverPending(sql, providers))
    .catch((e) => console.error('уведомления:', e?.message || e));
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
