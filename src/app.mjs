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
import { mailOps } from './ops/mail-ops.mjs';
import { bridgeOps } from './ops/bridge-ops.mjs';
import { validateRegistry } from './notify/registry.mjs';
import { memoryFileOps, testControlOps } from './ops/service-ops.mjs';
import { createRegistry, DEFAULT_MODULES } from './modules/index.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function listOps(cfg, providers) {
  const ops = [...coreOps(cfg), ...orderOps(), ...orgOps(), ...adminOps(), ...matchOps(), ...workOps(), ...moneyOps(), ...notifyOps(), ...aiOps(), ...mailOps(), ...bridgeOps(cfg)];
  if (providers.storage.kind === 'memory') ops.push(...memoryFileOps());
  if (cfg.appEnv === 'test' && cfg.testControlToken) ops.push(...testControlOps(cfg));
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
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'], dotfiles: 'ignore' }));
  app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Страница не найдена'));
  app.use(errorHandler());
  return app;
}
