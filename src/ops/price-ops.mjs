// Цены и правила «Переводов» в кабинете администратора (задача 2а.9, задача штаба 3f617197): посмотреть действующие и
// стартовые значения, сохранить правку (история — кто, когда, что); src/translation/settings.mjs. Только администратор.
// Новые значения действуют для расчёта новых заявок; цена, уже назначенная в заявке, не меняется.
import { HttpError } from '../http/core.mjs';
import { audit } from './util.mjs';
import { saveSettings, settingsView, useSavedSettings } from '../translation/settings.mjs';
import { ackView, saveAckHours } from '../orders/ack.mjs';

export function priceOps() {
  return [
    {
      id: 'admin.translation_settings.get', method: 'GET', path: '/api/admin/translation-settings', auth: 'user', access: { platform: 'admin' },
      async handler({ sql }) {
        return { settings: await settingsView(sql) };
      },
    },
    {
      id: 'admin.translation_settings.save', method: 'PUT', path: '/api/admin/translation-settings', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, body }) {
        let saved;
        try {
          saved = await sql.tx(async (tx) => {
            const r = await saveSettings(tx, actor.id, body?.values);
            if (r.changes.length) await audit(tx, actor, 'translation_settings.save', 'module', 'translation', { changed: r.changes.map((c) => c.key) });
            return r;
          });
        } catch (e) {
          if (e?.settings) throw new HttpError(400, 'bad_settings', e.message);
          throw e;
        }
        useSavedSettings(saved.next);
        return { changes: saved.changes, settings: await settingsView(sql) };
      },
    },
    {
      // Срок первого ответа заказчику по модулям (задача штаба 3fd17197, src/orders/ack.mjs): часы или пусто — выключено.
      id: 'admin.order_ack.get', method: 'GET', path: '/api/admin/order-ack', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, registry }) {
        return { ack: await ackView(sql, registry) };
      },
    },
    {
      id: 'admin.order_ack.save', method: 'PUT', path: '/api/admin/order-ack', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, body, registry }) {
        let changed;
        try {
          changed = await sql.tx(async (tx) => {
            const c = await saveAckHours(tx, registry, actor.id, body?.hours);
            if (c.length) await audit(tx, actor, 'order_ack.save', 'module', 'order_ack', { changed: c });
            return c;
          });
        } catch (e) {
          if (e?.settings) throw new HttpError(400, 'bad_settings', e.message);
          throw e;
        }
        return { changed, ack: await ackView(sql, registry) };
      },
    },
  ];
}
