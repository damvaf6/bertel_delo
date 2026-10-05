// Локальный стенд демо-площадки (APP_ENV=demo на локальной базе, порт 8789): чистая база, наполнение демо-делами
// тем же сбросом, что ночью в облаке. Для проверки tests/demo/demo.spec.mjs без облака (CI и разработка).
import { loadConfig } from '../../src/config.mjs';
import { createDb } from '../../src/db.mjs';
import { migrate } from '../../src/migrate.mjs';
import { createProviders } from '../../src/providers/index.mjs';
import { createApp } from '../../src/app.mjs';
import { DB_URL, resetDatabase } from '../helpers.mjs';

const KEY = 'demo-stand-reset-key-0123456789abcdefgh';
await resetDatabase();
const cfg = { ...loadConfig({ APP_ENV: 'test', DATABASE_URL: DB_URL, DB_SSL: 'disable', COOKIE_SECURE: '0', PORT: '8789' }), appEnv: 'demo', demoResetKey: KEY };
const sql = createDb(cfg);
await migrate(sql);
const app = createApp({ cfg, sql, providers: createProviders(cfg) });
// Сначала наполнение по внутреннему порту, и только потом — порт проверки 8789 (иначе проверка начнётся раньше).
const inner = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
const r = await fetch(`http://127.0.0.1:${inner.address().port}/__demo/reset`, { method: 'POST', headers: { 'x-delo-request': '1', 'x-demo-reset': KEY } });
console.log('демо-стенд наполнен:', r.status, await r.text());
inner.close();
const server = app.listen(8789, '127.0.0.1', () => console.log('демо-стенд готов: http://127.0.0.1:8789'));
process.on('SIGTERM', () => { server.close(); sql.end().finally(() => process.exit(0)); });
