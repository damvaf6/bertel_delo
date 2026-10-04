// Распознавание текста на скриншоте (2.32: ИИ читает скриншот объявления и предлагает признаки аналога).
//   ocr.recognize({ buf, mime }) → { text }   — только картинки (jpeg, png); PDF читается без распознавания (src/ai/extract.mjs)
// Поставщик — настройка OCR_PROVIDER: '' (выключено: эксперт вставляет текст объявления сам), 'fake' (проверки),
// 'yandex' (Yandex Vision OCR, данные в России; ключ — тот же сервисный аккаунт, что у YandexGPT, с правом ai.vision.user).
import { makeFake, ProviderError } from './fake.mjs';

export const OCR_DRIVERS = ['', 'fake', 'yandex'];
export const OCR_MIME = ['image/jpeg', 'image/png'];
const TIMEOUT_MS = 30_000;

export function createOcr(cfg) {
  const d = cfg.providers.ocr;
  if (!d) return null;
  if (d === 'fake') return fakeOcr();
  if (d === 'yandex') return yandexOcr(cfg.ocr.yandex);
  throw new Error(`Распознавание «${d}» не подключено`);
}

function yandexOcr(c) {
  return {
    driver: 'yandex',
    async recognize({ buf, mime }) {
      const r = await fetch(c.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Api-Key ${c.apiKey}`, 'x-folder-id': c.folder, 'x-data-logging-enabled': 'false' },
        body: JSON.stringify({ mimeType: mime === 'image/png' ? 'PNG' : 'JPEG', languageCodes: ['ru', 'en'], model: 'page', content: buf.toString('base64') }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Текст ответа в журнал не пишем: в нём содержимое скриншота.
      if (!r.ok) throw new ProviderError('ocr', `ответ ${r.status}`);
      let data;
      try { data = JSON.parse(await r.text()); } catch { throw new ProviderError('ocr', 'неверный формат ответа'); }
      return { text: String(data?.result?.textAnnotation?.fullText ?? '') };
    },
  };
}

// Поддельное распознавание: текст «нарисован» в файле после метки «OCR:» (так проверки кладут его в картинку).
function fakeOcr() {
  return Object.assign(makeFake('ocr', {
    recognize: async ({ buf }) => {
      const s = buf.toString('utf8');
      const at = s.indexOf('OCR:');
      return { text: at >= 0 ? s.slice(at + 4).trim() : '' };
    },
  }), { driver: 'fake' });
}
