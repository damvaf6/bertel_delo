// Проверка юриста перед соглашением (задача штаба 40217197-…-81f7, решение Дамира 23.10.2026): ФИО → карточка только из
// фактов — запись в реестре адвокатов Минюста и опубликованные решения судов, где он представлял сторону. Без рейтингов и
// «процента побед»: исход дела не показывается вовсе; других участников дел не называем — «о чём дело» одной фразой пишет
// российская модель (YandexGPT или GigaChat), а имена и названия, если модель их оставила, программа убирает сама.
// Общая часть для всех мест, где нужна карточка: страница проверки и (позже) выбор юриста в «Деле».
//
// Источник сведений — за интерфейсом:
//   find({ name })            → [{ reg_no, full_name, region, chamber, status, formation, since }]
//   cases({ reg_no, name })   → [{ key, court, number, date, kind, url, text }]
// Пока источник один — вымышленные юристы (fakeLawyerSource): настоящий реестр и решения судов подключаются после
// просмотра Дамиром, по программам карточки от Лили (lawyer_card.py, egra.py), из контура в России.

export const STATUS_NAME = { active: 'Статус адвоката действует', suspended: 'Статус приостановлен', ended: 'Статус прекращён' };
export const KIND_NAME = { civil: 'Гражданское дело', arbitration: 'Арбитражное дело', admin: 'Административное дело', criminal: 'Уголовное дело' };
const NAME_MIN = 3;
const NAME_MAX = 120;
export const CASES_MAX = 20;

// ФИО для поиска: буквы, пробел и дефис; регистр и «ё» не важны.
export function searchName(value) {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (v.length < NAME_MIN || v.length > NAME_MAX || !/^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z .-]*$/.test(v)) return null;
  return v;
}
const fold = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// Имена и названия других участников, если модель их оставила: «Петров П.П.», «Петрова П. П.», ООО «Ромашка», «АО Альфа».
const PERSON_RE = /[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.?/g;
const ORG_RE = /(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|НКО|АНО|ГУП|МУП|ФГУП)\s*(?:«[^»]{1,80}»|"[^"]{1,80}"|[А-ЯЁ][\wА-Яа-яЁё-]*)/g;
const QUOTED_RE = /«[^»]{1,80}»/g;
export const HIDDEN = '(участник скрыт)';
export function withoutParties(text) {
  return String(text ?? '').replace(ORG_RE, HIDDEN).replace(PERSON_RE, HIDDEN).replace(QUOTED_RE, HIDDEN)
    .replace(/\s+/g, ' ').trim();
}

export function subjectPrompt(c) {
  return [
    { role: 'system', content: 'Ты помогаешь проверить юриста по опубликованным решениям судов. Ответь одной короткой фразой '
      + '(до 20 слов), о чём спор или дело: предмет, без имён людей, без названий организаций, без сумм и без исхода — кто '
      + 'выиграл, не пиши. Начни с «О …» или «Спор о …». Только эта фраза, без пояснений.' },
    { role: 'user', content: `ДЕЛО: ${c.kind ? KIND_NAME[c.kind] ?? '' : ''} ${c.number}\nТЕКСТ:\n${String(c.text ?? '').slice(0, 4000)}` },
  ];
}

// Ответ модели → фраза: первая строка, без кавычек, без участников; пустая или длинная — нет фразы.
export function subjectFrom(answer) {
  const line = String(answer ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const s = withoutParties(line.replace(/^["«'](.*)["»']$/, '$1'));
  return s && s.length <= 300 ? s : null;
}

// Карточка: факты реестра и дела; у каждого дела — «о чём» (из сохранённого или от модели), без исхода и участников.
//   subjectOf(c) → Promise<string | null> — даёт вызывающий (учёт обращений к модели и сохранение — там).
export async function buildCard(source, lawyer, subjectOf) {
  const found = (await source.cases({ reg_no: lawyer.reg_no, name: lawyer.full_name })).slice(0, CASES_MAX);
  const cases = [];
  for (const c of found) {
    let subject = null;
    try { subject = await subjectOf(c); } catch { subject = null; }
    cases.push({ key: c.key, court: c.court, number: c.number, date: c.date, kind_name: KIND_NAME[c.kind] ?? 'Дело', url: c.url, subject });
  }
  cases.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    reg_no: lawyer.reg_no,
    full_name: lawyer.full_name,
    fictional: !!lawyer.fictional,
    registry: {
      title: 'Реестр адвокатов Минюста России',
      region: lawyer.region, chamber: lawyer.chamber, formation: lawyer.formation ?? null, since: lawyer.since ?? null,
      status: lawyer.status, status_name: STATUS_NAME[lawyer.status] ?? 'Статус не указан',
    },
    cases,
    cases_note: cases.length
      ? 'Дела найдены по фамилии, имени и отчеству в опубликованных решениях судов. Если дело не этого юриста — нажмите «Оспорить».'
      : 'Опубликованных решений судов с этим юристом не нашлось. Это не плохо и не хорошо: решения публикуют не все и не сразу.',
    sources_note: 'Только факты из открытых источников: без оценок, рейтингов и исходов дел; других участников дел не называем.',
  };
}

// Вымышленные юристы — только для проверки работы страницы; в настоящих реестрах таких людей нет.
const FAKE = [
  { reg_no: '77/99001', full_name: 'Пробный Адвокат Иванович', region: 'Москва', chamber: 'Адвокатская палата г. Москвы',
    formation: 'Коллегия адвокатов «Учебная»', since: '2014-03-12', status: 'active',
    cases: [
      { key: 'fake-1', court: 'Учебный районный суд г. Москвы', number: '2-1001/2026', date: '2026-04-15', kind: 'civil', url: 'https://sudact.ru/',
        text: 'Решение по иску Петрова П.П. к ООО «Ромашка» о взыскании долга по договору займа.\nПредставитель истца — адвокат Пробный А.И.' },
      { key: 'fake-2', court: 'Учебный арбитражный суд', number: 'А40-2002/2025', date: '2025-11-02', kind: 'arbitration', url: 'https://sudact.ru/',
        text: 'Дело о поставке некачественного товара для АО «Альфа».\nОтветчик — ИП Сидоров С.С.' },
    ] },
  { reg_no: '50/99002', full_name: 'Пробный Адвокат Петрович', region: 'Московская область', chamber: 'Адвокатская палата Московской области',
    formation: 'Адвокатский кабинет', since: '2019-09-01', status: 'suspended', cases: [] },
  { reg_no: '77/99003', full_name: 'Учебная Юристка Сергеевна', region: 'Москва', chamber: 'Адвокатская палата г. Москвы',
    formation: 'Адвокатское бюро «Тестовое»', since: '2009-06-30', status: 'ended',
    cases: [
      { key: 'fake-3', court: 'Учебный городской суд', number: '33-3003/2024', date: '2024-02-20', kind: 'civil', url: 'https://sudact.ru/',
        text: 'Апелляция по спору о разделе совместно нажитого имущества супругов Кузнецовой К.К. и Кузнецова К.К.' },
    ] },
];

export function fakeLawyerSource() {
  const calls = [];
  return {
    kind: 'fake',
    calls,
    async find({ name }) {
      calls.push({ method: 'find', name });
      const q = fold(name).split(' ');
      return FAKE.filter((l) => q.every((w) => fold(l.full_name).split(' ').some((p) => p.startsWith(w))))
        .map(({ cases, ...l }) => ({ ...l, fictional: true }));
    },
    async cases({ reg_no }) {
      calls.push({ method: 'cases', reg_no });
      return FAKE.find((l) => l.reg_no === reg_no)?.cases ?? [];
    },
  };
}

// Поддельная модель: «о чём» — по словам «о …» из текста, участники остаются (их убирает subjectFrom, как у настоящей).
export function fakeSubject(text) {
  const body = String(text.split('ТЕКСТ:')[1] ?? text);
  const m = body.match(/(?:^|\s)о\s+(.{3,160}?)\.?$/m);
  return m ? `О ${m[1]}` : 'О споре по договору';
}
