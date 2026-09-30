// Сборка приложения ядра: настройки → база → поставщики → операции → страницы.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './http/core.mjs';
import { mountOps, errorHandler } from './http/router.mjs';
import { coreOps } from './ops/core-ops.mjs';
import { orgOps } from './ops/org-ops.mjs';
import { adminOps } from './ops/admin-ops.mjs';
import { memoryFileOps, testControlOps } from './ops/service-ops.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function listOps(cfg, providers) {
  const ops = [...coreOps(), ...orgOps(), ...adminOps()];
  if (providers.storage.kind === 'memory') ops.push(...memoryFileOps());
  if (cfg.appEnv === 'test' && cfg.testControlToken) ops.push(...testControlOps(cfg));
  return ops;
}

export function createApp({ cfg, sql, providers }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy ? 1 : false);
  app.use(securityHeaders(cfg));

  const ops = listOps(cfg, providers);
  mountOps(app, ops, { cfg, sql, providers });
  app.locals.ops = ops.map(({ id, method, path, auth, access }) => ({ id, method, path, auth, access }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Не найдено' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'], dotfiles: 'ignore' }));
  app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Страница не найдена'));
  app.use(errorHandler());
  return app;
}
