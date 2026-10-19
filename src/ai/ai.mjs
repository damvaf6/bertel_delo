// Обращение к модели ИИ от имени человека: дневной лимит, учёт, понятная ошибка. Подсказки (промпты) — здесь же.
// Устав: ИИ-консультация — разъяснение, не юридическая услуга, всегда заканчивается «что сделать самому» или
// «вот специалист»; ИИ ничего не подаёт и не отправляет сам; проверка — помощь, подпись и ответственность у человека.
import { HttpError } from '../http/core.mjs';
import { STATUS_NAME } from '../orders/workflow.mjs';
import { APPROACHES, BASIS_KINDS } from '../modules/index.mjs';
import { locateQuote } from './extract.mjs';
import { assignmentSource, findInDraft, swapValue } from '../../public/draftfind.js';

export const DISCLAIMER = 'Это разъяснение искусственного интеллекта, а не юридическая услуга. Решение принимаете Вы; '
  + 'за точной оценкой обращайтесь к специалисту.';

// Длина ответа модели по назначению: черновик заключения длинный, проверка — список по правилам.
const MAX_TOKENS = { draft: 6000, review: 3000, analog: 800 };

export async function askAi({ sql, providers, cfg }, actor, purpose, messages) {
  const used = await sql.one`select count(*)::int as n from ai_usage where user_id = ${actor.id} and at > now() - interval '1 day'`;
  if (used.n >= cfg.ai.dailyLimit) throw new HttpError(429, 'ai_limit', 'Лимит обращений к помощнику на сутки исчерпан, попробуйте завтра');
  // Предел расхода за месяц (решение Дамира 03.10.2026): дошли — настоящая модель не вызывается до 1-го числа.
  if (cfg.ai.budgetRub > 0 && (await monthSpentKop(sql)) >= cfg.ai.budgetRub * 100) {
    throw new HttpError(503, 'ai_budget', 'Лимит расхода на помощника в этом месяце исчерпан — обратитесь к администратору платформы');
  }
  try {
    const out = await providers.ai.complete({ purpose, messages, maxTokens: MAX_TOKENS[purpose] });
    const tokens = (out.driver ?? out.model) === 'fake' ? 0 : out.tokens ?? estimateTokens(messages, out.text);
    const cost = Math.ceil((tokens / 1000) * cfg.ai.priceRubPer1k * 100);
    await sql`insert into ai_usage (user_id, purpose, model, ok, tokens, cost_kop) values (${actor.id}, ${purpose}, ${out.model}, true, ${tokens}, ${cost})`;
    return out;
  } catch (e) {
    await sql`insert into ai_usage (user_id, purpose, model, ok) values (${actor.id}, ${purpose}, null, false)`;
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'ai_unavailable', 'Помощник сейчас недоступен, попробуйте позже');
  }
}

// Начало текущего месяца по Москве.
export async function monthSpentKop(sql) {
  const r = await sql.one`select coalesce(sum(cost_kop), 0)::bigint as kop, coalesce(sum(tokens), 0)::bigint as tokens from ai_usage
                          where at >= date_trunc('month', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow'`;
  return Number(r.kop);
}

export async function monthUsage(sql) {
  const r = await sql.one`select coalesce(sum(cost_kop), 0)::bigint as kop, coalesce(sum(tokens), 0)::bigint as tokens, count(*)::int as calls
                          from ai_usage where at >= date_trunc('month', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow'`;
  return { kop: Number(r.kop), tokens: Number(r.tokens), calls: r.calls };
}

// Поставщик не сообщил токены — считаем с запасом: знак ≈ треть токена для русского текста.
const estimateTokens = (messages, answer) => Math.ceil((messages.reduce((n, m) => n + String(m.content).length, 0) + String(answer ?? '').length) / 3);

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
        'Юридических консультаций не давай: не советуй, подавать ли иск или жалобу и как их составить, не называй статьи',
        'законов, не оценивай шансы выиграть суд. Если вопрос правовой — скажи, что это вопрос к юристу.',
        'Объясняй коротко — до пяти предложений, простыми словами. В self_steps — от одного до пяти конкретных действий.',
        `Услуги платформы:\n${services}`,
        'Ответь только JSON без пояснений: {"explanation": "...", "self_steps": ["..."], "specialist": "кто нужен" | null,',
        '"service": {"module": "...", "service": "..."} | null, "title": "короткое название заявки" | null,',
        '"fields": {"id поля": "вариант"}} — в fields только поля с выбором и только если это ясно из описания.',
        'В service — коды из списка услуг (до и после «/»), а не названия. Пример: {"explanation": "Нужна оценка квартиры…",',
        '"self_steps": ["Соберите документы на квартиру"], "specialist": "Оценщик недвижимости", "service": {"module": "expertise",',
        '"service": "realty"}, "title": "Оценка квартиры для суда", "fields": {"purpose": "court", "region": "moscow"}}',
      ].join('\n'),
    },
    { role: 'user', content: problem },
  ];
}

// Услуга в ответе модели — в любом из видов, которые встречались у настоящих моделей: {"module", "service"},
// «expertise/realty», просто «realty» или название услуги. Только из перечня; иначе — null.
function serviceFromAnswer(registry, v) {
  if (!v) return null;
  const all = registry.catalog().flatMap((m) => m.services.map((s) => ({ m: m.id, s: s.id, name: s.name.toLowerCase() })));
  let mod = '';
  let svc = '';
  if (typeof v === 'string') [mod, svc] = v.includes('/') ? v.split('/') : ['', v];
  else if (typeof v === 'object') { mod = String(v.module ?? ''); svc = String(v.service ?? v.id ?? ''); }
  svc = svc.trim();
  const byId = all.filter((x) => x.s === svc && (!mod || x.m === mod.trim()));
  const hit = byId.length === 1 ? byId[0] : all.find((x) => x.name === svc.toLowerCase());
  return hit ? registry.service(hit.m, hit.s) : null;
}

// Юридическая консультация — не услуга помощника (устав: «разъяснение, не юридическая услуга»). Фразы с советом судиться,
// ссылками на статьи законов или прогнозом исхода дела убираются из ответа; вместо них — «это вопрос к юристу».
const LEGAL_ADVICE = [
  /(?:подайте|подавайте|подать|составьте|обжалуйте|обжаловать)[^.!?]{0,40}(?:иск|претензи|жалоб|апелляц|кассац|заявлени[ея] в суд)/i,
  /(?:^|[\s(«])(?:ст\.|стать[яиеюё]й?)\s*\d+/i,
  /(?:ГК|ГПК|АПК|УК|УПК|КоАП|ЖК|СК|НК|ЗК)\s*РФ/,
  /(?:закон|кодекс)\w*\s+(?:об?|о защите|N|№)\s*[^.!?]{0,40}(?:вы\s+)?(?:вправе|имеете право)/i,
  /шанс\w*[^.!?]{0,20}(?:выигр|успех|побед|проигр)/i,
  /(?:выиграете|проиграете|суд\s+(?:скорее всего|наверняка|точно|обязательно)\s+\w+)/i,
  /(?:исков\w*\s+давност|срок\w*\s+давност)/i,
  /(?:по закону|законом)\s+вы\s+(?:имеете право|вправе|можете требовать|обязаны)/i,
];
// Вопрос сам по себе правовой: стоит ли судиться, как составить иск, выиграю ли.
const LEGAL_QUESTION = /(?:выиграю|шанс|подавать ли|стоит ли (?:судиться|подавать|обращаться в суд)|как (?:составить|написать|подать) (?:иск|претензи|жалоб)|как[ауюя]{1,2} стать|по какой статье|в иске|в исковом|законно ли|имею ли (?:я )?право)/i;
export const LEGAL_NOTE = 'Правовую сторону — подавать ли в суд, какие сроки и шансы — помощник не оценивает: это вопрос к юристу.';
const legalAdvice = (s) => LEGAL_ADVICE.some((re) => re.test(s));
// Предложение кончается точкой и пробелом перед заглавной буквой («ст. 15» — не конец предложения).
const sentences = (s) => s.split(/(?<=[.!?…])\s+(?=[A-ZА-ЯЁ«"(])/).filter(Boolean);
// Ответ без шагов «что сделать самому» не отдаём (устав): тогда — общий первый шаг.
const DEFAULT_STEP = 'Запишите, что случилось и когда, и соберите документы, которые у Вас есть: договоры, фото, переписку';

// Ответ модели → то, что увидит человек. Услуга и поля — только из перечня модуля; остальное отбрасывается.
// Ответ всегда заканчивается «что сделать самому» (хотя бы один шаг) и «к кому обратиться»; советы юриста — убираются.
export function cleanProblemAnswer(registry, text, problem = '') {
  const a = cleanProblemJson(registry, text);
  let legal = LEGAL_QUESTION.test(problem);
  const kept = sentences(a.explanation).filter((x) => !legalAdvice(x));
  if (kept.join(' ') !== sentences(a.explanation).join(' ')) legal = true;
  const steps = a.self_steps.filter((x) => !legalAdvice(x));
  if (steps.length !== a.self_steps.length) legal = true;
  if (legalAdvice(a.specialist ?? '')) { a.specialist = null; legal = true; }
  a.explanation = kept.join(' ') || (a.service
    ? `Похоже, Вам нужна услуга «${a.service.name}». Специалист разберётся в деталях.`
    : 'Помощник не нашёл подходящей услуги по Вашему описанию. Опишите подробнее, что случилось и что нужно получить.');
  a.self_steps = steps.length ? steps : [DEFAULT_STEP];
  if (!a.specialist) a.specialist = a.service ? a.service.name : legal ? 'Юрист' : null;
  a.legal_note = legal ? LEGAL_NOTE : null;
  return a;
}

function cleanProblemJson(registry, text) {
  const j = parseJsonAnswer(text);
  if (!j) {
    return { explanation: clip(text, 3000), self_steps: [], specialist: null, service: null, title: null, fields: {} };
  }
  const def = serviceFromAnswer(registry, j.service);
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
// omit — поля, которые черновик берёт из выписки ЕГРН или задания на оценку (прогон 2.290): прежнее значение из заявки
// модели не даём — иначе оно попадает в текст рядом с верным, и ИИ-проверка находит в отчёте «другой адрес».
export function orderBrief(registry, order, { omit = [] } = {}) {
  const def = order.module ? registry.service(order.module, order.service) : null;
  const fields = (def?.fields ?? []).filter((f) => order.fields?.[f.id] !== undefined && !omit.includes(f.id)).map((f) => {
    const v = order.fields[f.id];
    const shown = f.type === 'select' ? f.options.find((o) => o.id === v)?.name ?? v : v;
    return `${f.label}: ${shown}`;
  });
  return [
    `Заявка «${order.title}»`,
    def ? `Услуга: ${def.module.name} — ${def.service.name}` : null,
    `Статус: ${STATUS_NAME[order.status]}`,
    order.deadline ? `Срок: ${order.deadline}` : 'Срок не указан',
    // Номер и дата определения (2.79) — чтобы модель писала основание целиком, а не «Определение суда» без реквизитов.
    `Основание: ${[BASIS_KINDS[order.basis_kind]?.name ?? '—', order.basis_number ? `№ ${order.basis_number}` : '', order.basis_date ? `от ${String(order.basis_date instanceof Date ? order.basis_date.toISOString() : order.basis_date).slice(0, 10).split('-').reverse().join('.')}` : ''].filter(Boolean).join(' ')}`,
    ...fields,
    // Подходы, которые выбрал исполнитель (2.33): черновик и проверка опираются на них.
    order.approaches?.length
      ? `Подходы к оценке: применяются — ${order.approaches.map((a) => APPROACHES[a]).join(', ')}; не применяются — ${Object.keys(APPROACHES).filter((a) => !order.approaches.includes(a)).map((a) => APPROACHES[a]).join(', ') || 'нет'}`
      : null,
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

export function reviewMessages({ rules, brief, files, found = {} }) {
  const auto = rules.flatMap((r) => (found[r.id] ?? []).map((f) => `- ${r.id}: ${f.text} (${f.file}, ${f.where})`));
  return [
    {
      role: 'system',
      content: [
        'Ты помощник проверяющего. Проверь результат работы специалиста по каждому правилу из списка.',
        'Ты только подсказываешь: «ok» — замечаний не видно, «attention» — человеку стоит посмотреть, с коротким пояснением.',
        'Если текст результата не прочитан — «attention» с пояснением. Решение и подпись — у человека.',
        'Сверяй части отчёта между собой: титул, выводы, задание на оценку, описание объекта, расчёт и итог должны говорить',
        'одно и то же (год, VIN, номер, даты, собственник, суммы, подходы). Пересчитывай арифметику, которую видишь.',
        'Ищи следы чужого шаблона: другой объект, другая дата, лишние разделы, противоречащие друг другу абзацы.',
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
        ...rules.map((r) => `- ${r.id}: ${r.title}${r.ask ? `. Что проверить: ${r.ask}` : ''}`),
        ...(auto.length ? ['УЖЕ НАЙДЕНО АВТОМАТИЧЕСКИ (по всему тексту; не повторяй, ищи другое):', ...auto] : []),
        'ФАЙЛЫ:',
        ...files.map((f) => `[${f.name}]\n${f.text === null ? '(текст не прочитан: файл не удалось прочитать или такой вид файла помощник не читает)' : f.text}${f.truncated ? '\n(часть страниц не поместилась — их помощник не видел)' : ''}`),
      ].join('\n'),
    },
  ];
}

// Подсказки по каждому правилу; правило, о котором модель промолчала, — «посмотрите сами». Отмеченные места — только
// цитаты, которые нашлись в тексте отчёта (с файлом и страницей); выдуманные модель цитаты отбрасываются.
// found — автоматические находки (src/ai/report-checks.mjs) по правилу: они показываются всегда и делают правило
// «посмотрите», даже если модель замечаний не увидела или не ответила.
const NO_REMARKS = /^\s*(замечани[йя] (не (найдено|выявлено|обнаружено)|нет)|нет замечаний|всё в порядке|все в порядке)[.!]?\s*$/i;
export function cleanReviewAnswer(rules, text, docs = [], found = {}) {
  const j = parseJsonAnswer(text);
  const items = Array.isArray(j?.items) ? j.items : [];
  return rules.map((r) => {
    const it = items.find((x) => x?.id === r.id);
    const auto = found[r.id] ?? [];
    const hint = it?.hint === 'ok' && !auto.length ? 'ok' : 'attention';
    let note = clip(it?.note, 1000);
    if (!note) note = auto.length ? 'есть автоматические находки — см. ниже' : it ? '' : 'Помощник не дал ответа по этому правилу — проверьте сами';
    // «Замечаний не найдено» модели рядом с находками читалось как противоречие (прогон 2.190) — такие слова не повторяем,
    // остальной ответ модели — с пометкой, что это её слова.
    else if (auto.length && it?.hint === 'ok') {
      note = `модель замечаний не увидела, но есть автоматические находки — см. ниже${NO_REMARKS.test(note) ? '' : `. Модель: ${note}`}`;
    }
    const marks = [];
    for (const q of (Array.isArray(it?.quotes) ? it.quotes : []).slice(0, 3)) {
      if (typeof q !== 'string') continue;
      const at = locateQuote(docs, q);
      if (at) marks.push({ ...at, quote: clip(q.replace(/\s+/g, ' ').trim(), 200) });
    }
    return { id: r.id, hint, note, marks, ...(auto.length ? { found: auto } : {}) };
  });
}

// Последняя ИИ-проверка для круга, который сейчас на экране: исполнитель в работе смотрит будущий круг (перед сдачей).
export async function aiReviewView(sql, order) {
  const round = order.status === 'in_work' ? order.review_round + 1 : order.review_round;
  if (round < 1) return null;
  const r = await sql.one`select id, round, side, model, items, files, at from ai_reviews
                          where order_id = ${order.id} and round = ${round} order by id desc limit 1`;
  if (!r) return null;
  const prev = await prevReview(sql, order, r);
  const recheck = await docsAfterReview(sql, order, r.at);
  return { round: r.round, side: r.side, model: r.model, items: r.items, files: r.files, at: r.at, ...(prev ? { prev } : {}), ...(recheck ? { recheck } : {}) };
}

// Пришёл запрошенный документ после ИИ-проверки (2.248): заказчик приложил файл к просьбе (выписка ЕГРН, техпаспорт…)
// позже, чем ИИ проверял отчёт, — проверка не видела этот документ, исполнителю подсказка «проверьте заново». Пока дело в
// работе; удалённый файл не в счёт. { docs: [{ title, filename, at }], egrn } или null; egrn — среди них выписка ЕГРН.
export async function docsAfterReview(sql, order, at) {
  if (order.status !== 'in_work' || !at) return null;
  const rows = await sql`select r.item_id, r.title, r.fulfilled_at, d.filename from doc_requests r
                         join documents d on d.id = r.document_id and d.deleted_at is null
                         where r.order_id = ${order.id} and r.cancelled_at is null and r.fulfilled_at > ${at}
                         order by r.fulfilled_at, r.id`;
  if (!rows.length) return null;
  return { docs: rows.map((x) => ({ title: x.title, filename: x.filename, at: x.fulfilled_at })), egrn: rows.some((x) => x.item_id === 'egrn') };
}

// Последняя ИИ-проверка текущего круга (как в aiReviewView) и документы, пришедшие после неё, — для «Сегодня» (2.248).
export async function aiRecheck(sql, order) {
  if (order.status !== 'in_work') return null;
  const r = await sql.one`select at from ai_reviews where order_id = ${order.id} and round = ${order.review_round + 1}
                          order by id desc limit 1`;
  const recheck = r ? await docsAfterReview(sql, order, r.at) : null;
  return recheck ? { ...recheck, review_at: r.at } : null;
}

// Что изменилось с ИИ-проверки прежней версии файла (2.206): последняя более ранняя проверка этого дела (любого круга —
// обычно до возврата руководителя или диспетчера), где проверялись другие файлы. По правилам: «посмотрите» было и ушло —
// gone, осталось — kept, появилось — fresh. Прежняя проверка без «посмотрите» и нынешняя без них — сравнивать нечего.
const fileSet = (files) => (files ?? []).map((f) => f.id).sort().join(',');
async function prevReview(sql, order, cur) {
  const rows = await sql`select items, files, at from ai_reviews where order_id = ${order.id} and id < ${cur.id}
                         order by id desc limit 20`;
  const p = rows.find((x) => fileSet(x.files) !== fileSet(cur.files));
  if (!p) return null;
  const att = (items) => new Set((items ?? []).filter((i) => i.hint === 'attention').map((i) => i.id));
  const before = att(p.items);
  const now = att(cur.items);
  if (!before.size && !now.size) return null;
  const known = new Set((p.items ?? []).map((i) => i.id));
  return {
    at: p.at, files: (p.files ?? []).map((f) => f.name),
    gone: [...before].filter((id) => !now.has(id)),
    kept: [...before].filter((id) => now.has(id)),
    // Новое «посмотрите» — только по правилам, которые прежняя проверка тоже смотрела.
    fresh: [...now].filter((id) => !before.has(id) && known.has(id)),
  };
}

// Напоминание перед подписью (2.136): для каждого файла результата — последняя ИИ-проверка этого круга, в которой этот файл
// (эта версия: новый файл — новый документ) был. Нет такой — 'none' (other: проверяли, но другие файлы, например прежнюю
// версию); есть пункты «посмотрите» — 'attention' с названиями правил; иначе null. Подсказка, не запрет: подпись не держит.
// Руководителю перед подписью организации (2.186) — { ok: true }: проверено без замечаний — 'ok' с временем проверки.
// Находка по выписке ЕГРН коротко (2.225): без имени файла выписки, страниц, строки заявки и совета в конце.
export function egrnShort(f) {
  return String(f.text ?? '')
    .replace(` «${f.egrn?.file ?? ''}»`, '')
    .replace(/;\s*в заявке — .*?(?=\)?\s—\s|$)/, '')
    .replace(/\s—\s(?:проверьте|площадь берётся)[^]*$/, '')
    .replace(/,\s*стр\.\s*\d+\)/g, ')')
    .replace(/\s*\(стр\.\s*\d+\)/g, '')
    .trim().slice(0, 180);
}

// 2.269: находка, сверенная с заявкой или заданием на оценку (fix.from, без выписки), — коротко, как egrnShort: без совета
// и «… берётся из задания» в конце (у цели и заказчика — тоже, 2.296) и страниц; откуда верное значение — «в заявке» /
// «в задании на оценку» (без имени файла). 2.313: у пользователя результатов оценки — без «: при оценке для банка …».
export function fixShort(f) {
  const text = String(f.text ?? '')
    .replace(/;\s*(?:дата оценки|вид стоимости|цель|заказчик) берётся[^]*$/, '')
    .replace(/:\s*при оценке для банка пользователь результатов[^]*$/, '')
    .replace(/\s—\s(?:проверьте|исправьте)[^]*$/, '')
    .replace(/\s*\(стр\.\s*\d+\)/g, '')
    .trim().slice(0, 180);
  return { text, from: String(f.fix?.from ?? '').replace(/\s*«[^»]*»\s*$/, '').trim() };
}

// Прогон 2.320: дата составления отчёта позже срока из задания на оценку (2.302) или раньше даты задания (2.298) — находка без
// замены (fix), но сверена с заданием: руководителю тоже пунктом, коротко — без имени файла, страницы и совета; что сделать —
// `todo` (не «исправьте, как в задании»: дату в задании не берут, её ставит эксперт).
const TASK_DATE = /^Дата составления отчёта \([^)]*\) (позже срока из|раньше даты) (задания на оценку|письма заказчика|определения суда) /u;
const TASK_FROM = { 'задания на оценку': 'в задании на оценку', 'письма заказчика': 'в письме заказчика', 'определения суда': 'в определении суда' };
const isTaskDate = (f) => !f.egrn && !f.fix && TASK_DATE.test(String(f.text ?? ''));
export function taskDateShort(f) {
  const [, kind, what] = String(f.text ?? '').match(TASK_DATE) ?? [];
  if (!kind) return null;
  const text = String(f.text).replace(/\s«[^»]*»/u, '').replace(/,\s*стр\.\s*\d+\)/g, ')').replace(/\s—\s[^]*$/, '').trim().slice(0, 180);
  return { text, from: TASK_FROM[what], todo: kind === 'позже срока из'
    ? 'исправьте дату составления или приложите к делу документ о переносе срока' : 'исправьте дату составления' };
}
// 2.322: даты пункта из короткого текста (taskDateShort) — дата составления, срок по заданию (late) или дата задания; для
// «К месту в черновике» у пункта возврата. Не та находка — null.
const TASK_DATE_SHORT = /^Дата составления отчёта \((\d{2}\.\d{2}\.\d{4})\) (позже срока из|раньше даты) [^(]*\((?:не позднее )?(\d{2}\.\d{2}\.\d{4})\)/u;
export function taskDateOf(short) {
  const [, made, kind, edge] = String(short ?? '').match(TASK_DATE_SHORT) ?? [];
  return made ? { made, edge, late: kind === 'позже срока из' } : null;
}
const orderShort = (f) => (f.fix?.from ? fixShort(f) : taskDateShort(f));
const isOrder = (f) => !f.egrn && (f.fix?.from || isTaskDate(f));

// Пункты возврата из расхождений с выпиской ЕГРН (2.247): находки последней проверки файла — правило, верное значение из
// выписки и короткий текст (как в «Вернуть эксперту», 2.236). Пункт привязан, если начинается с этого текста.
const egrnTrim = (t) => String(t ?? '').replace(/[.\s]+$/, '');
const egrnNorm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export function egrnLinks(review, docId) {
  if (!review) return [];
  const file = (review.files ?? []).find((f) => f.id === docId)?.name;
  return (review.items ?? []).filter((i) => i.hint === 'attention').flatMap((i) => (i.found ?? [])
    .filter((f) => f.egrn && (!file || f.file === file))
    .map((f) => ({ rule: i.id, ...(f.egrn.right ? { right: f.egrn.right } : {}), short: egrnShort(f) }))
    // 2.271: и находки, сверенные с заявкой или заданием на оценку (2.269), — kind 'order', верное значение — fix.right.
    .concat((i.found ?? []).filter((f) => isOrder(f) && (!file || f.file === file))
      .map((f) => ({ rule: i.id, kind: 'order', ...(f.fix?.right ? { right: f.fix.right } : {}), short: orderShort(f).text }))));
}
export function egrnLinkOf(point, links) {
  return links.find((l) => l.short && point.startsWith(egrnTrim(l.short))) ?? null;
}
// Ушло ли расхождение пункта в проверке после возврата: правило не смотрели или проверки нет — 'none'; та же находка
// (то же верное значение из выписки или тот же текст) — 'kept'; иначе 'gone'. Пункт по заявке и заданию (2.271) — так же,
// только среди находок без выписки, верное значение — из заявки или задания.
export function egrnLinkState(link, review, docIds) {
  const item = review && (review.items ?? []).find((i) => i.id === link.rule);
  if (!item) return 'none';
  const files = new Set((review.files ?? []).filter((f) => docIds.includes(f.id)).map((f) => f.name));
  const order = link.kind === 'order';
  const same = (item.found ?? []).some((f) => (order ? isOrder(f) : f.egrn) && (!files.size || files.has(f.file))
    && (order
      ? (link.right && f.fix?.right && egrnNorm(f.fix.right) === egrnNorm(link.right)) || egrnTrim(orderShort(f).text) === egrnTrim(link.short)
      : (link.right && f.egrn.right && egrnNorm(f.egrn.right) === egrnNorm(link.right)) || egrnTrim(egrnShort(f)) === egrnTrim(link.short)));
  return same ? 'kept' : 'gone';
}

// 2.263: заменено ли расхождение в черновике — значения из файла в тексте уже нет, а значение из выписки есть.
const swappedIn = (body, f) => !findInDraft(body, { bad: f.egrn.bad, quote: f.quote })
  && !!findInDraft(body, { bad: swapValue(f.egrn, f.egrn.bad), quote: f.quote });

// draft — текущий черновик ({ body, at }), created — когда загружен каждый файл: для руководителя (2.263) — расхождения
// с выпиской, которые эксперт заменил в черновике уже после того, как загрузил этот файл (swapped).
export async function aiSignHints(sql, registry, order, docIds, { ok = false, draft = null, created = null } = {}) {
  const out = new Map();
  if (!docIds.length) return out;
  const rows = await sql`select items, files, at from ai_reviews
                         where order_id = ${order.id} and round = ${order.review_round + 1} order by id desc`;
  const titles = new Map(registry.checks(order.module, order.service, order.fields).map((r) => [r.id, r.title]));
  for (const id of docIds) {
    const r = rows.find((x) => (x.files ?? []).some((f) => f.id === id));
    if (!r) { out.set(id, { state: 'none', other: rows.length > 0 }); continue; }
    const att = (r.items ?? []).filter((i) => i.hint === 'attention');
    // 2.225: находки, сверенные с выпиской ЕГРН из дела, — коротко, одной строкой у файла (только по этому файлу).
    const file = (r.files ?? []).find((f) => f.id === id)?.name;
    const mine = att.flatMap((i) => i.found ?? []).filter((f) => f.egrn && (!file || f.file === file));
    const egrn = mine.map(egrnShort);
    // 2.258: из них те, что можно заменить в черновике одной кнопкой (как «Заменить на значение из выписки» — swapValue).
    const can = mine.filter((f) => f.egrn.bad && swapValue(f.egrn));
    const swap = can.map(egrnShort);
    // 2.269: находки, сверенные с заявкой или заданием на оценку, — для «Вернуть эксперту» пунктами, как расхождения с выпиской.
    // 2.279: и правило находки — эксперту в окне подписи «К находке» ведёт к нему в ИИ-проверке.
    const byOrder = [...new Map(att.flatMap((i) => (i.found ?? []).map((f) => ({ f, rule: i.id })))
      .filter(({ f }) => isOrder(f) && (!file || f.file === file))
      .map(({ f, rule }) => ({ ...orderShort(f), rule })).filter((x) => x.text).map((x) => [x.text, x])).values()];
    const at = created?.get(id);
    const swapped = draft && at && new Date(draft.at) > new Date(at) ? can.filter((f) => swappedIn(draft.body, f)).map(egrnShort) : [];
    out.set(id, att.length ? { state: 'attention', at: r.at, count: att.length, titles: att.map((i) => (titles.get(i.id) ?? i.id).split(':')[0].trim()).slice(0, 3),
      ...(egrn.length ? { egrn: [...new Set(egrn)] } : {}), ...(swap.length ? { swap } : {}), ...(byOrder.length ? { order: byOrder } : {}),
      ...(swapped.length ? { swapped: [...new Set(swapped)], draft_at: draft.at } : {}) }
      : ok ? { state: 'ok', at: r.at } : null);
  }
  return out;
}

// 2.266: для «Сегодня» и утренней сводки эксперта — расхождения с выпиской ЕГРН из последней ИИ-проверки его неподписанных
// файлов (как 2.258), которые можно заменить одной кнопкой и которые ещё стоят в черновике (значение из файла в тексте есть).
// Заменил или в черновике этих значений нет — пусто. Коротко, без повторов.
// 2.284: так же — расхождения с заданием на оценку (письмом, определением суда), которые можно заменить кнопкой «Заменить на
// значение из задания» (assignmentSource): { egrn, task }.
export async function egrnSwapLeft(sql, order, docIds, body) {
  const out = { egrn: [], task: [] };
  if (!docIds.length || !body) return out;
  const rows = await sql`select files, items from ai_reviews
                         where order_id = ${order.id} and round = ${order.review_round + 1} order by id desc`;
  for (const id of docIds) {
    const r = rows.find((x) => (x.files ?? []).some((f) => f.id === id));
    if (!r) continue;
    const file = (r.files ?? []).find((f) => f.id === id)?.name;
    for (const f of (r.items ?? []).filter((i) => i.hint === 'attention').flatMap((i) => i.found ?? [])) {
      if (file && f.file !== file) continue;
      if (f.egrn) {
        if (f.egrn.bad && swapValue(f.egrn) && findInDraft(body, { bad: f.egrn.bad, quote: f.quote })) out.egrn.push(egrnShort(f));
      } else if (f.fix?.bad && assignmentSource(f.fix) && findInDraft(body, { bad: f.fix.bad, quote: f.quote })) {
        out.task.push(fixShort(f).text);
      }
    }
  }
  return { egrn: [...new Set(out.egrn)], task: [...new Set(out.task.filter(Boolean))] };
}

// 2.272: для «Сегодня» и утренней сводки эксперта — расхождения с выпиской ЕГРН из последней ИИ-проверки его неподписанных
// файлов, которые он уже заменил в черновике после загрузки файла (как 2.263 у руководителя). versions — версии черновика
// ({ body, at }, по порядку, последняя — текущая; первой может идти версия, что была при загрузке файла), created — когда
// загружен каждый файл, newest — самый свежий свой файл результата: собран после последней из этих замен — Word уже собран
// заново, пусто. 2.280: так же расхождения с заявкой и заданием на оценку (`fix.from`) — исправлены в черновике (значения из
// файла нет, верное есть), а в какой-то версии с загрузки файла прежнее значение стояло — { swapped, fixed }.
const fixedIn = (body, f) => !findInDraft(body, { bad: f.fix.bad, quote: f.quote })
  && !!findInDraft(body, { bad: swapValue(f.fix, f.fix.bad) ?? f.fix.right, quote: f.quote });
export async function egrnRebuildLeft(sql, order, docIds, versions, created, newest) {
  const draft = versions.at(-1);
  const none = { swapped: [], fixed: [] };
  if (!docIds.length || !draft?.body) return none;
  const rows = await sql`select files, items from ai_reviews
                         where order_id = ${order.id} and round = ${order.review_round + 1} order by id desc`;
  const swapped = [], fixed = [];
  let last = null;
  for (const id of docIds) {
    const at = created.get(id);
    if (!at || new Date(draft.at) <= new Date(at)) continue;
    const r = rows.find((x) => (x.files ?? []).some((f) => f.id === id));
    if (!r) continue;
    const file = (r.files ?? []).find((f) => f.id === id)?.name;
    // Версии с загрузки файла: та, что была при загрузке, и все после неё.
    const from = Math.max(0, versions.findLastIndex((v) => new Date(v.at) <= new Date(at)));
    for (const f of (r.items ?? []).filter((i) => i.hint === 'attention').flatMap((i) => i.found ?? [])) {
      if (file && f.file !== file) continue;
      const egrn = f.egrn && f.egrn.bad && swapValue(f.egrn) && swappedIn(draft.body, f);
      const order = !egrn && !f.egrn && f.fix?.from && f.fix.bad && f.fix.right && fixedIn(draft.body, f)
        && versions.slice(from, -1).some((v) => findInDraft(v.body, { bad: f.fix.bad, quote: f.quote }));
      if (!egrn && !order) continue;
      const done = egrn ? swappedIn : fixedIn;
      // Когда замена появилась: первая версия после загрузки файла, начиная с которой верное значение стоит без перерыва.
      let since = draft.at;
      for (let i = versions.length - 1; i >= 0 && new Date(versions[i].at) > new Date(at) && done(versions[i].body, f); i -= 1) since = versions[i].at;
      if (!last || new Date(since) > new Date(last)) last = since;
      if (egrn) swapped.push(egrnShort(f));
      else fixed.push(fixShort(f).text);
    }
  }
  if (!(swapped.length || fixed.length) || (newest && last && new Date(newest) >= new Date(last))) return none;
  return { swapped: [...new Set(swapped)], fixed: [...new Set(fixed.filter(Boolean))] };
}

// ——— Черновик заключения (задача 2.2) ———

export const DRAFT_MAX = 50_000;
// Места, которые эксперт должен заполнить сам: пока они есть, черновик не становится файлом результата.
export const DRAFT_GAP = /\[(?:заполнить|описать)[^\]]*\]/i;

export function draftMessages({ brief, sections, photos, docs }) {
  return [
    {
      role: 'system',
      content: [
        'Ты помощник эксперта. Подготовь ЧЕРНОВИК заключения по данным заявки, документам и списку фото.',
        'Это только черновик: эксперт проверит и поправит каждое слово, сам сделает расчёт и выводы, подпишет и отвечает за текст.',
        'Пиши только то, что следует из данных. Не придумывай цифры, стоимость, аналоги, даты, имена, номера и адреса.',
        'Где данных нет или нужен расчёт и вывод эксперта — оставь пометку в квадратных скобках: [заполнить: что именно].',
        'Фото ты не видишь — только их список. Для каждого фото оставь строку «Фото N (имя файла): [описать по фото: имя файла]».',
        'Разделы — строго по списку и в том же порядке, каждый начинается строкой «## Название раздела» (с номером, если он есть).',
        'Пиши только про этот вид объекта: никаких слов о другом виде имущества (недвижимость, земля — в отчёте о машине).',
        'Ответь только текстом черновика, без пояснений до и после.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        brief,
        'РАЗДЕЛЫ:',
        ...sections.map((s) => `- ${s.id}: ${s.title}${s.ask ? `. Что писать: ${s.ask}` : ''}`),
        'ФОТО:',
        ...(photos.length ? photos.map((p) => `- ${p.name} (загружено ${p.at})`) : ['(фото к заявке не приложены)']),
        'ДОКУМЕНТЫ:',
        ...(docs.length
          ? docs.map((d) => `[${d.name}]\n${d.text === null ? '(текст не прочитан)' : d.text}${d.truncated ? '\n(дальше текст не поместился)' : ''}`)
          : ['(документов с текстом нет)']),
      ].join('\n'),
    },
  ];
}

const headKey = (s) => s.toLowerCase().replace(/ё/g, 'е').split(/[:,(]/)[0].replace(/\s+/g, ' ').trim();

// Ответ модели → текст черновика: без обёрток ```, не длиннее DRAFT_MAX; раздел, который модель пропустила, — добавляется
// пустым, с пометкой «заполнить», чтобы эксперт его не потерял.
export function cleanDraftAnswer(sections, text) {
  let body = String(text ?? '').replace(/^\s*```[a-z]*\s*\n?|\n?```\s*$/gi, '').replace(/\r\n?/g, '\n').trim();
  const heads = new Set([...body.matchAll(/^#{1,3}\s*(.+)$/gm)].map((m) => headKey(m[1])));
  const missing = sections.filter((s) => !heads.has(headKey(s.title)));
  if (missing.length) body = [body, ...missing.map((s) => `## ${s.title}\n[заполнить: раздел не подготовлен]`)].filter(Boolean).join('\n\n');
  return body.slice(0, DRAFT_MAX);
}

// ——— Аналог со скриншота (2.32) ———
// Модель получает ссылку и текст объявления (распознанный со скриншота, из PDF страницы или вставленный экспертом) и
// возвращает только признаки из списка. Имя и телефон продавца не просим и не берём: среди признаков их нет.
export const ANALOG_TEXT_MAX = 8000;

// Площадь участков в объявлениях — в сотках и гектарах (2.80): модель переводит в кв. м. Перечень из нескольких позиций —
// модель называет номер позиции, к которой подходит объявление (item_no).
export function analogMessages({ fields, url, text, positions = [] }) {
  const list = fields.map((f) => `- ${f.id}: ${f.label}${f.type === 'number' ? ' (число без пробелов и единиц)' : ''}${f.type === 'select' ? ` (одно из: ${f.options.map((o) => o.id).join(' | ')})` : ''}${f.id === 'listed_on' ? ' (ГГГГ-ММ-ДД)' : ''}${f.id === 'area' ? ' (в кв. м; сотки умножь на 100, гектары — на 10000)' : ''}${f.id === 'item_no' ? ' (номер позиции из ПЕРЕЧНЯ ОБЪЕКТА, на которую похоже объявление)' : ''}`);
  const items = positions.length ? ['ПЕРЕЧЕНЬ ОБЪЕКТА:', ...positions.map((x, i) => `${i + 1}. ${x}`)] : [];
  return [
    {
      role: 'system',
      content: [
        'Ты помощник эксперта-оценщика. По тексту объявления заполни признаки аналога.',
        'Бери только то, что прямо написано в объявлении. Чего нет — не пиши этот признак вовсе, ничего не выдумывай.',
        'Не пиши имя, телефон, почту продавца и любые другие сведения о людях.',
        'Ответь только JSON: {"fields": {"id признака": значение, …}}.',
      ].join('\n'),
    },
    { role: 'user', content: ['ПРИЗНАКИ:', ...list, ...items, 'ОБЪЯВЛЕНИЕ:', `Ссылка: ${url}`, 'ТЕКСТ:', text ? text.slice(0, ANALOG_TEXT_MAX) : '(текста нет — признаки только по ссылке)'].join('\n') },
  ];
}
