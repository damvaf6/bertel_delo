// ЮKassa (задача 2.46): оплата и возврат по API v3 (https://yookassa.ru/developers/api). Агентская схема — устав.
// Ключ магазина — из Lockbox через окружение. Вне prod — только тестовый магазин (секретный ключ «test_…»): на площадке
// настоящие деньги не списываются (src/config.mjs). Выплаты исполнителям — отдельный шлюз выплат ЮKassa и реквизиты
// исполнителей (решение Дамира): пока шлюза нет, выплата честно «не прошла», диспетчер повторит позже.
// Состоянию из уведомления ЮKassa не верим — ядро само спрашивает getPayment (money-ops.mjs).
import { ProviderError } from './fake.mjs';

const TIMEOUT_MS = 30_000;
const value = (kop) => (Number(kop) / 100).toFixed(2);

export function yookassa(c) {
  const auth = `Basic ${Buffer.from(`${c.shopId}:${c.secretKey}`).toString('base64')}`;
  async function call(method, path, { body, idempotenceKey } = {}) {
    let r;
    try {
      r = await fetch(`${c.url}${path}`, {
        method,
        headers: {
          authorization: auth, accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(idempotenceKey ? { 'idempotence-key': String(idempotenceKey).slice(0, 64) } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError('payments', 'ЮKassa не отвечает');
    }
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ниже — понятная ошибка */ }
    // Текст ответа в журнал не пишем целиком: в нём бывают данные плательщика.
    if (!r.ok) throw new ProviderError('payments', `ЮKassa: ${r.status} ${String(data?.code ?? '')} ${String(data?.parameter ?? '')}`.trim());
    if (!data) throw new ProviderError('payments', 'ЮKassa: неверный формат ответа');
    return data;
  }
  const status = (s) => (s === 'succeeded' ? 'succeeded' : s === 'canceled' ? 'canceled' : 'pending');
  return {
    name: 'yookassa',
    async createPayment({ idempotenceKey, orderId, amountKop, description, returnUrl, receipt }) {
      const body = {
        amount: { value: value(amountKop), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: String(description).slice(0, 128),
        metadata: { order_id: orderId },
      };
      // Чек 54-ФЗ — только когда включён в магазине и есть контакт покупателя (решение Дамира: «Решить Дамиру»).
      if (c.receipts && receipt?.customer) {
        body.receipt = {
          customer: receipt.customer,
          items: receipt.items.map((i) => ({
            description: String(i.description).slice(0, 128), quantity: '1.00', amount: { value: value(i.amountKop), currency: 'RUB' },
            vat_code: c.vatCode, payment_mode: 'full_payment', payment_subject: 'service', ...(i.agent ? { agent_type: 'agent' } : {}),
          })),
        };
      }
      const p = await call('POST', '/payments', { body, idempotenceKey });
      return { id: p.id, status: status(p.status), confirmationUrl: p.confirmation?.confirmation_url ?? null };
    },
    async getPayment({ id }) {
      const p = await call('GET', `/payments/${encodeURIComponent(id)}`);
      return { id: p.id, status: status(p.status) };
    },
    async createRefund({ idempotenceKey, paymentId, amountKop, description }) {
      if (!paymentId) return { id: null, status: 'failed', failure: 'нет номера платежа в ЮKassa' };
      const r = await call('POST', '/refunds', { idempotenceKey, body: { payment_id: paymentId, amount: { value: value(amountKop), currency: 'RUB' }, description: String(description).slice(0, 250) } });
      if (r.status === 'succeeded') return { id: r.id, status: 'succeeded' };
      // «pending» бывает у оплат со счёта (СБП, СберБизнес): деньги уже в пути; повтор с тем же ключом ЮKassa не задвоит.
      return { id: r.id, status: 'failed', failure: r.status === 'pending' ? 'возврат в обработке у ЮKassa — проверьте в личном кабинете магазина' : `ЮKassa отклонила возврат: ${r.cancellation_details?.reason ?? 'причина не указана'}` };
    },
    async createPayout() {
      return { id: null, status: 'failed', failure: 'шлюз выплат ЮKassa ещё не подключён — выплату проведёт диспетчер после подключения' };
    },
  };
}
