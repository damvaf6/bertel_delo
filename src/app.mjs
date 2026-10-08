// Сборка приложения ядра: настройки → база → поставщики → модули-профессии → операции → страницы.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './http/core.mjs';
import { mountOps, errorHandler } from './http/router.mjs';
import { coreOps } from './ops/core-ops.mjs';
import { orderOps } from './ops/order-ops.mjs';
import { orgOps } from './ops/org-ops.mjs';
import { adminOps } from './ops/admin-ops.mjs';
import { matchOps } from './ops/match-ops.mjs';
import { workOps } from './ops/work-ops.mjs';
import { moneyOps } from './ops/money-ops.mjs';
import { notifyOps } from './ops/notify-ops.mjs';
import { aiOps } from './ops/ai-ops.mjs';
import { draftOps } from './ops/draft-ops.mjs';
import { inspectOps } from './ops/inspect-ops.mjs';
import { onsiteOps } from './ops/onsite-ops.mjs';
import { signOps } from './ops/sign-ops.mjs';
import { dossierOps } from './ops/dossier-ops.mjs';
import { analogOps } from './ops/analog-ops.mjs';
import { templateOps } from './ops/template-ops.mjs';
import { mailOps } from './ops/mail-ops.mjs';
import { snippetOps } from './ops/snippet-ops.mjs';
import { remarkOps } from './ops/remark-ops.mjs';
import { bridgeOps } from './ops/bridge-ops.mjs';
import { todayOps } from './ops/today-ops.mjs';
import { problemOps } from './ops/problem-ops.mjs';
import { caseOps } from './ops/case-ops.mjs';
import { demoOps } from './ops/demo-ops.mjs';
import { validateRegistry } from './notify/registry.mjs';
import { memoryFileOps, testControlOps, stageLoginOps } from './ops/service-ops.mjs';
import { docRequestOps } from './ops/docreq-ops.mjs';
import { deadlineOps } from './ops/deadline-ops.mjs';
import { handoverOps } from './ops/handover-ops.mjs';
import { noteOps } from './ops/note-ops.mjs';
import { repeatOps } from './ops/repeat-ops.mjs';
import { similarOps } from './ops/similar-ops.mjs';
import { uploadOps } from './ops/upload-ops.mjs';
import { createRegistry, DEFAULT_MODULES } from './modules/index.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function listOps(cfg, providers) {
  const ops = [...coreOps(cfg), ...orderOps(), ...orgOps(), ...adminOps(), ...matchOps(), ...workOps(), ...moneyOps(), ...notifyOps(), ...aiOps(), ...draftOps(), ...inspectOps(), ...onsiteOps(), ...signOps(), ...dossierOps(), ...snippetOps(), ...remarkOps(), ...analogOps(), ...templateOps(), ...mailOps(), ...todayOps(), ...problemOps(), ...caseOps(), ...uploadOps(), ...docRequestOps(), ...deadlineOps(), ...handoverOps(), ...noteOps(), ...repeatOps(), ...similarOps(), ...bridgeOps(cfg)];
  if (providers.storage.kind === 'memory') ops.push(...memoryFileOps());
  if (cfg.appEnv === 'test' && cfg.testControlToken) ops.push(...testControlOps(cfg));
  ops.push(...stageLoginOps(cfg));
  // Демо-площадка: вход только кнопками за вымышленных людей — вход по телефону и коду выключен.
  if (cfg.appEnv === 'demo') {
    for (const id of ['auth.code', 'auth.verify']) ops.splice(ops.findIndex((o) => o.id === id), 1);
    ops.push(...demoOps(cfg));
  }
  if (cfg.appEnv === 'prod' && ops.some((o) => o.id === 'stage.login')) throw new Error('служебный вход на prod запрещён');
  if (cfg.appEnv !== 'demo' && ops.some((o) => o.id.startsWith('demo.'))) throw new Error('вход кнопками — только на демо-площадке');
  return ops;
}

// modules — описания модулей-профессий (по умолчанию — все модули ядра); ошибка в описании — приложение не собирается.
export function createApp({ cfg, sql, providers, modules = DEFAULT_MODULES }) {
  const registry = createRegistry(modules);
  validateRegistry();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy ? 1 : false);
  app.use(securityHeaders(cfg));

  const ops = listOps(cfg, providers);
  mountOps(app, ops, { cfg, sql, providers, registry });
  app.locals.registry = registry;
  app.locals.ops = ops.map(({ id, method, path, auth, access, csrf }) => ({ id, method, path, auth, access, csrf }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Не найдено' }));
  // Демо-площадка закрыта от поисковиков: robots.txt и заголовок X-Robots-Tag на каждом ответе (securityHeaders).
  if (cfg.appEnv === 'demo') app.get('/robots.txt', (req, res) => res.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'], dotfiles: 'ignore' }));
  app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Страница не найдена'));
  app.use(errorHandler());
  return app;
}
