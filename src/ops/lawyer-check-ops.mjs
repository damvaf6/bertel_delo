// Проверка юриста перед соглашением (задача штаба 40217197-…-81f7, решение Дамира 23.10.2026): ФИО → список совпадений
// из реестра адвокатов → карточка (реестр и опубликованные решения судов) → «Подтвердить» / «Оспорить» у карточки или дела.
// Решение Дамира 24.10.2026: страница открыта всем вошедшим (заказчикам — людям и компаниям), у дел показывается исход.
// Пока юристы вымышленные, на stage и prod страница — только у администратора (`open` у источника); заказчикам она
// откроется с настоящим реестром и судами. Остальным — «не найдено», как у чужого.
import { HttpError, rateLimiter } from '../http/core.mjs';
import { askAi } from '../ai/ai.mjs';
import { audit } from './util.mjs';
import { buildCard, searchName, subjectFrom, subjectPrompt } from '../lawyers/check.mjs';

const NOTE_MAX = 500;
const REG_RE = /^\d{2,3}\/\d{1,6}$/;

function regFrom(value) {
  const v = String(value ?? '').trim();
  if (!REG_RE.test(v)) throw new HttpError(404, 'not_found', 'Юрист с таким номером в реестре не найден');
  return v;
}

// Юрист по номеру реестра: источник ищет по ФИО, номер сверяется — так подменённый номер не даёт чужой карточки.
async function lawyerOf(providers, reg, name) {
  const q = searchName(name);
  const l = q && (await providers.lawyers.find({ name: q })).find((x) => x.reg_no === reg);
  if (!l) throw new HttpError(404, 'not_found', 'Юрист с таким номером в реестре не найден');
  return l;
}

function allowed(providers, actor) {
  if (!providers.lawyers.open && actor?.platform_role !== 'admin') throw new HttpError(404, 'not_found', 'Не найдено');
}

// Отметки: администратор видит все (кто и что оспорил — ему разбирать), остальные — только свои: чужие имена и пояснения
// заказчикам не показываются.
async function marksOf(sql, reg, actor) {
  const all = actor.platform_role === 'admin';
  const rows = await sql`select m.id, m.case_key, m.kind, m.note, m.created_at, m.user_id, u.full_name
                         from lawyer_check_marks m join users u on u.id = m.user_id
                         where m.reg_no = ${reg} and (${all} or m.user_id = ${actor.id})
                         order by m.created_at desc, m.id desc limit 100`;
  return rows.map((r) => ({ id: Number(r.id), case_key: r.case_key, kind: r.kind, note: r.note, at: r.created_at,
    by: r.full_name || null, mine: r.user_id === actor.id }));
}

export function lawyerCheckOps() {
  const findLimit = rateLimiter({ windowMs: 10 * 60_000, max: 60 });
  return [
    {
      // Видна ли страница вошедшему — по нему кабинет показывает раздел «Проверить юриста».
      id: 'lawyer_check.open', method: 'GET', path: '/api/lawyer-check/open', auth: 'user', access: 'self',
      async handler({ providers, actor }) {
        const open = !!providers.lawyers.open || actor.platform_role === 'admin';
        return { open, admin_only: open && !providers.lawyers.open };
      },
    },
    {
      id: 'lawyer_check.find', method: 'GET', path: '/api/lawyer-check', auth: 'user', access: 'self',
      rateLimit: (ip) => findLimit(ip),
      async handler({ providers, actor, query }) {
        allowed(providers, actor);
        const name = searchName(query.name);
        if (!name) throw new HttpError(400, 'bad_input', 'Введите фамилию, имя и отчество юриста — буквами, от 3 знаков');
        const found = await providers.lawyers.find({ name });
        return {
          lawyers: found.slice(0, 20).map((l) => ({ reg_no: l.reg_no, full_name: l.full_name, region: l.region, status: l.status, fictional: !!l.fictional })),
          note: found.length ? null : 'В реестре адвокатов такого человека нет. Юрист без статуса адвоката в реестр не входит — '
            + 'спросите у него документ об образовании и договор с понятным перечнем работ.',
        };
      },
    },
    {
      // Карточка: ФИО и номер реестра — из выбранной строки списка; «о чём дело» модель пишет один раз, потом — из сохранённого.
      id: 'lawyer_check.card', method: 'GET', path: '/api/lawyer-check/card', auth: 'user', access: 'self',
      async handler({ sql, providers, cfg, actor, query }) {
        allowed(providers, actor);
        const reg = regFrom(query.reg);
        const lawyer = await lawyerOf(providers, reg, query.name);
        const source = providers.lawyers.kind;
        const card = await buildCard(providers.lawyers, lawyer, async (c) => {
          const saved = await sql.one`select subject from lawyer_case_subjects where source = ${source} and case_key = ${c.key}`;
          if (saved) return saved.subject;
          const out = await askAi({ sql, providers, cfg }, actor, 'lawyer', subjectPrompt(c));
          const subject = subjectFrom(out.text);
          if (subject) {
            await sql`insert into lawyer_case_subjects (source, case_key, subject, model) values (${source}, ${c.key}, ${subject}, ${out.model})
                      on conflict do nothing`;
          }
          return subject;
        });
        return { card, marks: await marksOf(sql, reg, actor) };
      },
    },
    {
      // «Подтвердить» — сведения верны; «Оспорить» — с пояснением, что не так (дело не этого юриста, статус устарел).
      id: 'lawyer_check.mark', method: 'POST', path: '/api/lawyer-check/marks', auth: 'user', access: 'self',
      async handler({ sql, providers, actor, body, res }) {
        allowed(providers, actor);
        const reg = regFrom(body?.reg);
        const lawyer = await lawyerOf(providers, reg, body?.name);
        const kind = String(body?.kind ?? '');
        if (!['confirm', 'dispute'].includes(kind)) throw new HttpError(400, 'bad_input', 'Выберите: подтвердить или оспорить');
        let caseKey = null;
        if (body?.case !== undefined && body?.case !== null) {
          caseKey = String(body.case);
          const cases = await providers.lawyers.cases({ reg_no: reg, name: lawyer.full_name });
          if (!cases.some((c) => c.key === caseKey)) throw new HttpError(404, 'not_found', 'Такого дела в карточке нет');
        }
        const note = String(body?.note ?? '').trim();
        if (note.length > NOTE_MAX) throw new HttpError(400, 'bad_input', `Пояснение — не длиннее ${NOTE_MAX} символов`);
        if (kind === 'dispute' && !note) throw new HttpError(400, 'bad_input', 'Напишите, что в сведениях не так');
        await sql`insert into lawyer_check_marks (reg_no, case_key, user_id, kind, note) values (${reg}, ${caseKey}, ${actor.id}, ${kind}, ${note || null})`;
        await audit(sql, actor, `lawyer_check.${kind}`, 'lawyer', reg, { case: caseKey });
        res.status(201);
        return { marks: await marksOf(sql, reg, actor) };
      },
    },
  ];
}
