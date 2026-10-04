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
//   ai.complete({ purpose, messages })                             → { text, model }   (основная и запасная — ai.mjs)
//   mail.send({ to, subject, text, messageId, inReplyTo, references: [messageId…], attachments: [{ filename, contentType, content }] }) → { id }
//   mail.receive({ limit })  — новые письма на особый адрес (1.9) → [{ id, from, subject, text, messageId, inReplyTo: [],
//                              authenticated (SPF/DKIM пройдены), autoReply, attachments: [{ filename, contentType, content }] }]
//   mail.ack({ id })         — письмо сохранено у нас, у поставщика его можно убрать
//   ocr.recognize({ buf, mime }) — текст со скриншота аналога (2.32), интерфейс — ocr.mjs; null — выключено
//   sign.sign / sign.verify  — электронная подпись заключения (2.5), интерфейс — sign.mjs
import crypto from 'node:crypto';
import { makeFake } from './fake.mjs';
import { createAi } from './ai.mjs';
import { createOcr } from './ocr.mjs';
import { fakeSign } from './sign.mjs';
import { yookassa } from './yookassa.mjs';
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
  mail: () => fakeMail(),
};

// Поддельная почта: исходящие только записываются; входящие автотесты кладут в ящик (deliver), ядро забирает их receive.
function fakeMail() {
  const inbox = [];
  const fake = makeFake('mail', {
    send: async () => ({ id: id('mail') }),
  });
  // Приём не записывается в вызовы и не ломается сценарием отказа: отказ проверяется на отправке.
  fake.receive = async ({ limit = 20 } = {}) => inbox.slice(0, limit);
  fake.ack = async ({ id: mid }) => {
    const i = inbox.findIndex((x) => x.id === mid);
    if (i >= 0) inbox.splice(i, 1);
  };
  fake.deliver = (letter) => {
    const l = { id: id('in'), messageId: `<${crypto.randomUUID()}@test.mail>`, inReplyTo: [], authenticated: true, autoReply: false, attachments: [], ...letter };
    inbox.push(l);
    return l;
  };
  const reset = fake.reset;
  fake.reset = () => { reset(); inbox.length = 0; };
  return fake;
}

const FAKE_PAY_ID = /^pay_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
      // На площадке несколько копий ядра: платёж мог создать другая копия — свой номер поддельной оплаты считается
      // незавершённым платежом, чужой — отменённым.
      if (!store.has(pid)) {
        if (!FAKE_PAY_ID.test(pid)) return { id: pid, status: 'canceled' };
        store.set(pid, 'pending');
      }
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
    if (name === 'payments' && driver === 'yookassa') { out.payments = yookassa(cfg.yookassa); continue; }
    if (driver !== 'fake') throw new Error(`Поставщик «${name}: ${driver}» ещё не подключён`);
    out[name] = FAKES[name]();
  }
  out.ai = createAi(cfg);
  out.ocr = createOcr(cfg);
  if (cfg.providers.sign !== 'fake') throw new Error(`Поставщик «sign: ${cfg.providers.sign}» ещё не подключён`);
  out.sign = fakeSign(cfg.appSecret);
  const storage = cfg.providers.storage;
  if (storage === 'memory') out.storage = memoryStorage(cfg.appSecret);
  else if (storage === 's3') out.storage = s3Storage(cfg.s3);
  else throw new Error(`Хранилище «${storage}» неизвестно`);
  return out;
}
