// ИИ — модель как настройка (устав, раздел 2): основная (AI_PROVIDER) и запасная (AI_FALLBACK).
// Если основная не ответила — тот же запрос уходит запасной. Зарубежные модели не подключаются вовсе: допустимы только
// поставщики из списка AI_DRIVERS (данные заявок — персональные, только в России).
//   complete({ purpose, messages: [{ role: 'system' | 'user' | 'assistant', content }] }) → { text, model }
// purpose: 'problem' — вход через проблему; 'assistant' — ассистент; 'review' — проверка результата по правилам.
import crypto from 'node:crypto';
import { makeFake, ProviderError } from './fake.mjs';

export const AI_DRIVERS = ['fake', 'yandexgpt', 'gigachat'];
export const AI_DRIVER_NAME = { fake: 'Поддельная модель (проверки)', yandexgpt: 'YandexGPT', gigachat: 'GigaChat' };
const TIMEOUT_MS = 30_000;

// Основная и запасная модели одной цепочкой. Ответ помечается, какая модель ответила.
export function aiChain(drivers) {
  const list = drivers.filter(Boolean);
  return {
    drivers: list.map((d) => d.driver),
    async complete(args) {
      let last;
      for (const d of list) {
        try {
          const out = await d.complete(args);
          if (!out?.text || !String(out.text).trim()) throw new ProviderError('ai', 'пустой ответ модели');
          return { text: String(out.text), model: out.model || d.driver };
        } catch (e) {
          last = e;
          console.error(`ИИ (${d.driver}) не ответил:`, e?.message || e);
        }
      }
      throw last ?? new ProviderError('ai', 'модель не настроена');
    },
    reset() { list.forEach((d) => d.reset?.()); },
    get calls() { return list.flatMap((d) => d.calls ?? []); },
    script(mode) { list[0]?.script?.(mode); },
  };
}

export function createAi(cfg) {
  const make = (driver) => {
    if (!driver) return null;
    if (driver === 'fake') return Object.assign(fakeAi(), { driver });
    if (driver === 'yandexgpt') return Object.assign(yandexGpt(cfg.ai.yandex), { driver });
    if (driver === 'gigachat') return Object.assign(gigaChat(cfg.ai.gigachat), { driver });
    throw new Error(`Модель ИИ «${driver}» не подключена`);
  };
  return aiChain([make(cfg.providers.ai), make(cfg.ai.fallback)]);
}

async function postJson(url, { headers, body, form }) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'application/json' }), ...headers },
    body: form ? new URLSearchParams(form).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  // Текст ответа поставщика в журнал не пишем: в нём может быть содержимое заявки.
  if (!r.ok) throw new ProviderError('ai', `ответ ${r.status}`);
  try { return JSON.parse(text); } catch { throw new ProviderError('ai', 'неверный формат ответа'); }
}

const answerOf = (data) => data?.choices?.[0]?.message?.content;

// YandexGPT через OpenAI-совместимый API Yandex Cloud AI Studio. Ключ — из Lockbox через окружение.
function yandexGpt(c) {
  const model = `gpt://${c.folder}/${c.model}`;
  return {
    async complete({ messages }) {
      const data = await postJson(`${c.url}/chat/completions`, {
        headers: { authorization: `Api-Key ${c.apiKey}`, 'x-folder-id': c.folder },
        body: { model, messages, temperature: 0.3, max_tokens: 2000 },
      });
      return { text: answerOf(data), model: `yandexgpt:${c.model}` };
    },
  };
}

// GigaChat: сначала токен доступа (живёт 30 минут, храним до истечения), потом запрос. Сертификат НУЦ Минцифры —
// через NODE_EXTRA_CA_CERTS в контуре.
function gigaChat(c) {
  let token = null;
  let until = 0;
  async function access() {
    if (token && Date.now() < until - 60_000) return token;
    const data = await postJson(c.authUrl, {
      headers: { authorization: `Basic ${c.authKey}`, rquid: crypto.randomUUID() },
      form: { scope: c.scope },
    });
    if (!data?.access_token) throw new ProviderError('ai', 'нет токена доступа');
    token = data.access_token;
    until = Number(data.expires_at) || Date.now() + 25 * 60_000;
    return token;
  }
  return {
    async complete({ messages }) {
      const data = await postJson(`${c.url}/chat/completions`, {
        headers: { authorization: `Bearer ${await access()}` },
        body: { model: c.model, messages, temperature: 0.3, max_tokens: 2000 },
      });
      return { text: answerOf(data), model: `gigachat:${c.model}` };
    },
  };
}

// ——— Поддельная модель: отвечает по ключевым словам, чтобы проверки шли без облака ———

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

const SERVICE_WORDS = [
  ['land', /участ|земл|дач/i],
  ['vehicle', /машин|автомоб|транспорт|мотоцикл|грузовик|дтп/i],
  ['goods', /товар|брак|некачествен|магазин|покупк|телефон|ноутбук/i],
  ['realty', /квартир|комнат|дом\b|дома\b|недвижим|помещен|залив/i],
  ['movable', /мебел|оборудован|движимое|станок/i],
];
const PURPOSE_WORDS = [
  ['court', /суд/i], ['inheritance', /наслед|нотариус/i], ['bank', /ипотек|банк|залог/i], ['division', /раздел|развод/i],
  ['damage', /ущерб|залив|страхов|дтп|авари/i], ['deal', /прода|купи|купл/i],
];

function fakeProblem(text) {
  const service = SERVICE_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
  const purpose = PURPOSE_WORDS.find(([, re]) => re.test(text))?.[0];
  const region = /област|подмосков/i.test(text) ? 'mo' : /москв/i.test(text) ? 'moscow' : undefined;
  const fields = { ...(purpose ? { purpose } : {}), ...(region ? { region } : {}) };
  return JSON.stringify({
    explanation: service
      ? 'По Вашему описанию нужна независимая оценка: её делает эксперт-оценщик, результат — отчёт или заключение, которое принимают суд, нотариус и банк.'
      : 'Ваш вопрос пока не похож на оценку или экспертизу. Опишите подробнее, что случилось и что нужно получить.',
    self_steps: service
      ? ['Соберите документы на объект: правоустанавливающие документы, техпаспорт или ПТС', 'Если дело в суде — возьмите определение суда о назначении экспертизы']
      : ['Запишите, что произошло, даты и какие документы у Вас есть'],
    specialist: service ? 'Эксперт-оценщик' : null,
    service: service ? { module: 'expertise', service } : null,
    title: service ? `Оценка по описанию: ${text.slice(0, 60)}` : null,
    fields,
  });
}

// Правила проверки приходят строками «- id: описание»; текст файлов — после «ФАЙЛЫ:».
function fakeReview(text) {
  const ids = [...text.matchAll(/^- ([a-z][a-z0-9_]*): /gm)].map((m) => m[1]);
  const files = text.split('ФАЙЛЫ:')[1] ?? '';
  const unreadable = !/[а-яa-z]{3}/i.test(files.replace(/^\[[^\]]*\]$|^\(текст не прочитан.*$/gm, ''));
  return JSON.stringify({
    items: ids.map((id) => {
      if (unreadable) return { id, hint: 'attention', note: 'Текст результата прочитать не удалось — проверьте вручную' };
      if (id === 'technical' && /опечатк/i.test(files)) return { id, hint: 'attention', note: 'В тексте есть слово «опечатка» — проверьте орфографию' };
      if (id === 'calculation' && !/\d/.test(files)) return { id, hint: 'attention', note: 'В тексте нет ни одного числа — где расчёт?' };
      return { id, hint: 'ok', note: 'Замечаний не найдено' };
    }),
  });
}

function fakeAi() {
  return makeFake('ai', {
    complete: async ({ purpose, messages }) => {
      const text = lastUser(messages);
      if (purpose === 'problem') return { text: fakeProblem(text), model: 'fake' };
      if (purpose === 'review') return { text: fakeReview(text), model: 'fake' };
      return { text: `[поддельный ответ ИИ] Вы спросили: «${text.slice(0, 200)}». Это подсказка, решение — за Вами.`, model: 'fake' };
    },
  });
}
