// Обращение к модели ИИ от имени человека: дневной лимит, учёт, понятная ошибка. Подсказки (промпты) — здесь же.
// Устав: ИИ-консультация — разъяснение, не юридическая услуга, всегда заканчивается «что сделать самому» или
// «вот специалист»; ИИ ничего не подаёт и не отправляет сам; проверка — помощь, подпись и ответственность у человека.
import { HttpError } from '../http/core.mjs';
import { STATUS_NAME } from '../orders/workflow.mjs';
import { BASIS_KINDS } from '../modules/index.mjs';
import { locateQuote } from './extract.mjs';

export const DISCLAIMER = 'Это разъяснение искусственного интеллекта, а не юридическая услуга. Решение принимаете Вы; '
  + 'за точной оценкой обращайтесь к специалисту.';

export async function askAi({ sql, providers, cfg }, actor, purpose, messages) {
  const used = await sql.one`select count(*)::int as n from ai_usage where user_id = ${actor.id} and at > now() - interval '1 day'`;
  if (used.n >= cfg.ai.dailyLimit) throw new HttpError(429, 'ai_limit', 'Лимит обращений к помощнику на сутки исчерпан, попробуйте завтра');
  try {
    const out = await providers.ai.complete({ purpose, messages });
    await sql`insert into ai_usage (user_id, purpose, model, ok) values (${actor.id}, ${purpose}, ${out.model}, true)`;
    return out;
  } catch (e) {
    await sql`insert into ai_usage (user_id, purpose, model, ok) values (${actor.id}, ${purpose}, null, false)`;
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'ai_unavailable', 'Помощник сейчас недоступен, попробуйте позже');
  }
}

// Модель могла обернуть JSON в пояснения или ``` — берём первый объект целиком. Не вышло — null.
export function parseJsonAnswer(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ——— Вход через проблему ———

export function problemMessages(registry, problem) {
  const services = registry.catalog().flatMap((m) => m.services.map((s) => {
    const fields = s.fields.filter((f) => f.type === 'select').map((f) => `${f.id} (${f.options.map((o) => o.id).join('|')})`).join('; ');
    return `- ${m.id}/${s.id}: ${m.name} — ${s.name}. Поля с выбором: ${fields}`;
  })).join('\n');
  return [
    {
      role: 'system',
      content: [
        'Ты помощник платформы «БЕРТЕЛ Дело». Человек описывает свою проблему своими словами.',
        'Разъясни ситуацию простым языком, без юридических терминов, обращение на «Вы». Это разъяснение, не юридическая услуга.',
        'Обязательно скажи, что человек может сделать сам, и к какому специалисту обратиться.',
        'Если подходит одна из услуг платформы — укажи её; если ни одна не подходит — service: null.',
        'Ничего не выдумывай про закон и сроки; не обещай результат.',
        `Услуги платформы:\n${services}`,
        'Ответь только JSON без пояснений: {"explanation": "...", "self_steps": ["..."], "specialist": "кто нужен" | null,',
        '"service": {"module": "...", "service": "..."} | null, "title": "короткое название заявки" | null,',
        '"fields": {"id поля": "вариант"}} — в fields только поля с выбором и только если это ясно из описания.',
      ].join('\n'),
    },
    { role: 'user', content: problem },
  ];
}

// Ответ модели → то, что увидит человек. Услуга и поля — только из перечня модуля; остальное отбрасывается.
export function cleanProblemAnswer(registry, text) {
  const j = parseJsonAnswer(text);
  if (!j) {
    return { explanation: clip(text, 3000) || 'Помощник не смог разобрать вопрос.', self_steps: [], specialist: null, service: null, title: null, fields: {} };
  }
  const def = j.service ? registry.service(String(j.service.module ?? ''), String(j.service.service ?? '')) : null;
  const fields = {};
  if (def && j.fields && typeof j.fields === 'object') {
    for (const [k, v] of Object.entries(j.fields)) {
      const f = def.fields.find((x) => x.id === k && x.type === 'select');
      if (f && f.options.some((o) => o.id === v)) fields[k] = v;
    }
  }
  return {
    explanation: clip(j.explanation, 3000),
    self_steps: (Array.isArray(j.self_steps) ? j.self_steps : []).map((x) => clip(x, 500)).filter(Boolean).slice(0, 8),
    specialist: clip(j.specialist, 200) || (def ? def.service.name : null),
    service: def ? { module: def.module.id, service: def.service.id, name: def.service.name, module_name: def.module.name } : null,
    title: def ? clip(j.title, 300) || def.service.name : null,
    fields,
  };
}

// ——— Ассистент ———

// Сводка заявки для модели: что за услуга, статус, срок, поля. Без имён и телефонов людей.
export function orderBrief(registry, order) {
  const def = order.module ? registry.service(order.module, order.service) : null;
  const fields = (def?.fields ?? []).filter((f) => order.fields?.[f.id] !== undefined).map((f) => {
    const v = order.fields[f.id];
    const shown = f.type === 'select' ? f.options.find((o) => o.id === v)?.name ?? v : v;
    return `${f.label}: ${shown}`;
  });
  return [
    `Заявка «${order.title}»`,
    def ? `Услуга: ${def.module.name} — ${def.service.name}` : null,
    `Статус: ${STATUS_NAME[order.status]}`,
    order.deadline ? `Срок: ${order.deadline}` : 'Срок не указан',
    `Основание: ${BASIS_KINDS[order.basis_kind]?.name ?? '—'}`,
    ...fields,
  ].filter(Boolean).join('\n');
}

export function assistantMessages({ scopeName, history, brief, question }) {
  return [
    {
      role: 'system',
      content: [
        'Ты личный помощник пользователя платформы «БЕРТЕЛ Дело» по его делам. Отвечай коротко, простым языком, на «Вы».',
        'Ты только подсказываешь: ничего не отправляешь, не подаёшь и не подписываешь сам; решение и ответственность — у человека.',
        'Не выдумывай факты; если не знаешь — скажи и предложи обратиться к специалисту.',
        `Раздел памяти: ${scopeName}.`,
        brief ? `Пользователь спрашивает о заявке:\n${brief}` : 'Заявка к вопросу не приложена.',
      ].join('\n'),
    },
    ...history.map((m) => ({ role: m.role, content: m.body })),
    { role: 'user', content: question },
  ];
}

// ——— ИИ-проверка результата ———

export function reviewMessages({ rules, brief, files }) {
  return [
    {
      role: 'system',
      content: [
        'Ты помощник проверяющего. Проверь результат работы специалиста по каждому правилу из списка.',
        'Ты только подсказываешь: «ok» — замечаний не видно, «attention» — человеку стоит посмотреть, с коротким пояснением.',
        'Если текст результата не прочитан — «attention» с пояснением. Решение и подпись — у человека.',
        'К каждому «attention» приведи до трёх коротких точных цитат из файлов (слово в слово, 5–200 знаков) — места,',
        'которые человеку стоит посмотреть. Не пересказывай и не придумывай цитаты: место без точной цитаты не покажут.',
        'Ответь только JSON: {"items": [{"id": "id правила", "hint": "ok" | "attention", "note": "пояснение", "quotes": ["цитата"]}]}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        brief,
        'ПРАВИЛА:',
        ...rules.map((r) => `- ${r.id}: ${r.title}`),
        'ФАЙЛЫ:',
        ...files.map((f) => `[${f.name}]\n${f.text === null ? '(текст не прочитан: файл не удалось прочитать или такой вид файла помощник не читает)' : f.text}${f.truncated ? '\n(дальше текст не поместился — его помощник не видел)' : ''}`),
      ].join('\n'),
    },
  ];
}

// Подсказки по каждому правилу; правило, о котором модель промолчала, — «посмотрите сами». Отмеченные места — только
// цитаты, которые нашлись в тексте отчёта (с файлом и страницей); выдуманные модель цитаты отбрасываются.
export function cleanReviewAnswer(rules, text, docs = []) {
  const j = parseJsonAnswer(text);
  const items = Array.isArray(j?.items) ? j.items : [];
  return rules.map((r) => {
    const it = items.find((x) => x?.id === r.id);
    const hint = it?.hint === 'ok' ? 'ok' : 'attention';
    const note = clip(it?.note, 1000) || (it ? '' : 'Помощник не дал ответа по этому правилу — проверьте сами');
    const marks = [];
    for (const q of (Array.isArray(it?.quotes) ? it.quotes : []).slice(0, 3)) {
      if (typeof q !== 'string') continue;
      const at = locateQuote(docs, q);
      if (at) marks.push({ ...at, quote: clip(q.replace(/\s+/g, ' ').trim(), 200) });
    }
    return { id: r.id, hint, note, marks };
  });
}

// Последняя ИИ-проверка для круга, который сейчас на экране: исполнитель в работе смотрит будущий круг (перед сдачей).
export async function aiReviewView(sql, order) {
  const round = order.status === 'in_work' ? order.review_round + 1 : order.review_round;
  if (round < 1) return null;
  const r = await sql.one`select round, side, model, items, files, at from ai_reviews
                          where order_id = ${order.id} and round = ${round} order by id desc limit 1`;
  return r && { round: r.round, side: r.side, model: r.model, items: r.items, files: r.files, at: r.at };
}
