// Реестр поставщиков внешних сервисов. Каждый — за своим интерфейсом, выбор — настройкой.
// Настоящие поставщики (СМС/звонок, ЮKassa, YandexGPT/GigaChat, почта) подключаются после облака и договоров.
//   sms.sendCode({ phone, code })                                  → { id }
//   payments.createPayment({ orderId, amountKop, description })    → { id, confirmationUrl }
//   payments.getPayment({ id })                                    → { id, status }
//   ai.complete({ purpose, messages })                             → { text, model }
//   mail.send({ to, subject, text })                               → { id }
import crypto from 'node:crypto';
import { makeFake } from './fake.mjs';
import { memoryStorage, s3Storage } from './storage.mjs';

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const FAKES = {
  sms: () => makeFake('sms', {
    sendCode: async () => ({ id: id('sms') }),
  }),
  payments: () => makeFake('payments', {
    createPayment: async ({ orderId }) => { const pid = id('pay'); return { id: pid, confirmationUrl: `/fake-pay/${pid}?order=${orderId}` }; },
    getPayment: async ({ id: pid }) => ({ id: pid, status: 'succeeded' }),
  }),
  ai: () => makeFake('ai', {
    complete: async ({ purpose }) => ({ text: `[поддельный ответ ИИ: ${purpose}]`, model: 'fake' }),
  }),
  mail: () => makeFake('mail', {
    send: async () => ({ id: id('mail') }),
  }),
};

export function createProviders(cfg) {
  const out = {};
  for (const name of Object.keys(FAKES)) {
    const driver = cfg.providers[name];
    if (driver !== 'fake') throw new Error(`Поставщик «${name}: ${driver}» ещё не подключён`);
    out[name] = FAKES[name]();
  }
  const storage = cfg.providers.storage;
  if (storage === 'memory') out.storage = memoryStorage(cfg.appSecret);
  else if (storage === 's3') out.storage = s3Storage(cfg.s3);
  else throw new Error(`Хранилище «${storage}» неизвестно`);
  return out;
}
