// Локальный стенд для проверки интерфейса: чистая тестовая база + ядро на порту 8788.
import { startApp, s3TestEnv } from '../helpers.mjs';

const app = await startApp(s3TestEnv() || {});
const server = app.app.listen(8788, '127.0.0.1', () => console.log('стенд готов: http://127.0.0.1:8788'));
process.on('SIGTERM', () => { server.close(); app.close().finally(() => process.exit(0)); });
