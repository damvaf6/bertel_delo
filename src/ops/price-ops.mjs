// Цены и правила «Переводов» в кабинете администратора (задача 2а.9, задача штаба 3f617197): посмотреть действующие и
// стартовые значения, сохранить правку (история — кто, когда, что); src/translation/settings.mjs. Только администратор.
// Новые значения действуют для расчёта новых заявок; цена, уже назначенная в заявке, не меняется.
import { HttpError } from '../http/core.mjs';
import { audit } from './util.mjs';
import { saveSettings, settingsView, useSavedSettings } from '../translation/settings.mjs';

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
  ];
}
