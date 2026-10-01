// Реестр поставщиков внешних сервисов. Каждый — за своим интерфейсом, выбор — настройкой.
// Настоящие поставщики (СМС/звонок, ЮKassa, YandexGPT/GigaChat, почта) подключаются после облака и договоров.
//   sms.sendCode({ phone, code })                                  → { id }
//   sms.send({ phone, text })       — уведомление (задача 1.7)     → { id }
//   call.sendCode({ phone, code })  — звонок, робот называет код   → { id }
//   payments.createPayment({ idempotenceKey, orderId, amountKop, description, returnUrl, receipt })
//                                                                  → { id, status, confirmationUrl }
//   payments.getPayment({ id })                                    → { id, status: pending | succeeded | canceled }
//   payments.createPayout({ idempotenceKey, executorId, amountKop, description }) → { id, status: succeeded | failed }
//   payments.createRefund({ idempotenceKey, paymentId, amountKop, description })  → { id, status: succeeded | failed }
//   ai.complete({ purpose, messages })                             → { text, model }
//   mail.send({ to, subject, text })                               → { id }
import crypto from 'node:crypto';
import { makeFake } from './fake.mjs';
import { memoryStorage, s3Storage } from './storage.mjs';

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const FAKES = {
  sms: () => makeFake('sms', {
    sendCode: async () => ({ id: id('sms') }),
    send: async () => ({ id: id('sms') }),
  }),
  call: () => makeFake('call', {
    sendCode: async () => ({ id: id('call') }),
  }),
  payments: () => fakePayments(),
  ai: () => makeFake('ai', {
    complete: async ({ purpose }) => ({ text: `[поддельный ответ ИИ: ${purpose}]`, model: 'fake' }),
  }),
  mail: () => makeFake('mail', {
    send: async () => ({ id: id('mail') }),
  }),
};

// Поддельная ЮKassa: «страница оплаты» сразу возвращает на returnUrl; при первой проверке незавершённый платёж
// получает исход nextOutcome (по умолчанию «оплачен»). Автотесты могут задать «отменён», неудачу выплаты (payoutOutcome)
// и неудачу возврата (refundOutcome).
function fakePayments() {
  const store = new Map();
  const fake = makeFake('payments', {
    createPayment: async ({ returnUrl }) => {
      const pid = id('pay');
      store.set(pid, 'pending');
      return { id: pid, status: 'pending', confirmationUrl: returnUrl };
    },
    getPayment: async ({ id: pid }) => {
      if (!store.has(pid)) return { id: pid, status: 'canceled' };
      if (store.get(pid) === 'pending') store.set(pid, fake.nextOutcome);
      return { id: pid, status: store.get(pid) };
    },
    createPayout: async () => (fake.payoutOutcome === 'failed'
      ? { id: id('payout'), status: 'failed', failure: 'тестовый отказ выплаты' }
      : { id: id('payout'), status: 'succeeded' }),
    createRefund: async () => (fake.refundOutcome === 'failed'
      ? { id: id('refund'), status: 'failed', failure: 'тестовый отказ возврата' }
      : { id: id('refund'), status: 'succeeded' }),
  });
  fake.nextOutcome = 'succeeded';
  fake.payoutOutcome = 'succeeded';
  fake.refundOutcome = 'succeeded';
  const reset = fake.reset;
  fake.reset = () => {
    reset(); store.clear(); fake.nextOutcome = 'succeeded'; fake.payoutOutcome = 'succeeded'; fake.refundOutcome = 'succeeded';
  };
  return fake;
}

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
