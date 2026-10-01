// Мост CRM → Платформа (задача 1.10): разбор и приём сообщений БЕРТЕЛ CRM. Только в одну сторону, Платформа в CRM не пишет.
// Устав, раздел 1: один профиль исполнителя (перенос из CRM один раз, с согласием, где упомянута Платформа), один список
// предложений (только «госзаказчик, язык, срок, объём, оплата по ПП № 1240» — без номера дела и фамилий; принимается в CRM),
// одна загрузка (CRM передаёт только число текущих дел — оно идёт в «дела вне платформы» для подбора).
// Поля сообщений — строго по списку: лишнее поле — запись не принимается (так в Платформу не попадёт ничего из дела).
import { HttpError } from '../http/core.mjs';
import { normPhone } from '../auth/auth.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { notify } from '../notify/notify.mjs';

export const LIMITS = { profiles: 500, load: 5000, offers: 1000 };
export const VOLUME_UNITS = { pages: 'стр.', signs: 'знаков', words: 'слов', hours: 'ч' };

const CRM_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Язык или пара языков: только буквы, пробелы, дефис, запятая, стрелка, скобки («китайский → русский»).
const LANGUAGE_RE = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё ,()→-]{0,59}$/;

// Похоже на данные дела или человека — номер дела («№ 1-234/2026», «12/2026»), фамилия с инициалами, телефон, почта.
// Госзаказчик — это название органа («ГСУ СК России по г. Москве»), а не человек и не дело.
const CASE_LIKE = [
  /[№#]/,
  /\d\s*[/\\]\s*\d/,
  /\d+\s*-\s*\d+\s*[/\\]/,
  /[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\./,
  /[А-ЯЁ]\.\s*[А-ЯЁ]\.\s*[А-ЯЁ][а-яё]+/,
  /@/,
  /\d{5,}/,
];
export const looksLikeCaseData = (s) => CASE_LIKE.some((re) => re.test(s));

class Reject extends Error {}
const reject = (reason) => { throw new Reject(reason); };

function plainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Только разрешённые поля, все обязательные — на месте.
function keysOnly(rec, allowed, required) {
  if (!plainObject(rec)) reject('запись — не объект');
  const extra = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (extra.length) reject(`лишние поля: ${extra.join(', ')}`);
  const missing = required.filter((k) => rec[k] === undefined || rec[k] === null || rec[k] === '');
  if (missing.length) reject(`нет полей: ${missing.join(', ')}`);
}

function str(v, field, max, { min = 1 } = {}) {
  if (typeof v !== 'string') reject(`${field}: строка`);
  const s = v.trim();
  if (s.length < min || s.length > max) reject(`${field}: от ${min} до ${max} символов`);
  return s;
}

function crmId(v, field = 'crm_id') {
  if (typeof v !== 'string' || !CRM_ID_RE.test(v)) reject(`${field}: латинские буквы, цифры и . _ : -, до 64 символов`);
  return v;
}

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function listOf(data, key, limit) {
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== key || !Array.isArray(data[key])) throw new HttpError(400, 'bad_message', `Сообщение: только поле «${key}» со списком`);
  if (data[key].length === 0 || data[key].length > limit) throw new HttpError(400, 'bad_message', `Сообщение: от 1 до ${limit} записей`);
  return data[key];
}

const tally = (results) => results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});

// ——— Профили исполнителей (перенос один раз; повтор — обновление языков, квалификации, почты, согласия) ———

function parseProfile(rec) {
  keysOnly(rec, ['crm_id', 'phone', 'email', 'full_name', 'languages', 'qualification', 'consent'], ['crm_id', 'phone', 'email', 'consent']);
  const id = crmId(rec.crm_id);
  const phone = normPhone(typeof rec.phone === 'string' ? rec.phone : '');
  if (!phone) reject('phone: мобильный телефон России');
  const email = str(rec.email, 'email', 254, { min: 3 }).toLowerCase();
  if (!EMAIL_RE.test(email)) reject('email: адрес почты');
  const fullName = rec.full_name === undefined ? '' : str(rec.full_name, 'full_name', 200);
  let languages = [];
  if (rec.languages !== undefined) {
    if (!Array.isArray(rec.languages) || rec.languages.length > 20) reject('languages: список до 20 языков');
    languages = rec.languages.map((l) => {
      const s = str(l, 'languages', 60);
      if (!LANGUAGE_RE.test(s)) reject('languages: название языка буквами');
      return s;
    });
    if (new Set(languages).size !== languages.length) reject('languages: повтор');
  }
  const qualification = rec.qualification === undefined ? '' : str(rec.qualification, 'qualification', 300);
  if (qualification && looksLikeCaseData(qualification)) reject('qualification: похоже на номер дела, телефон или почту');
  // Согласие на обработку персональных данных с упоминанием Платформы — без него профиль не переносится (устав, раздел 1).
  const c = rec.consent;
  if (!plainObject(c)) reject('consent: нет согласия');
  keysOnly(c, ['platform', 'version', 'given_at'], ['platform', 'version', 'given_at']);
  if (c.platform !== true) reject('consent: в согласии не упомянута Платформа');
  const version = str(c.version, 'consent.version', 40);
  const givenAt = typeof c.given_at === 'string' ? new Date(c.given_at) : null;
  if (!givenAt || Number.isNaN(givenAt.getTime()) || givenAt.getTime() > Date.now() + 60_000) reject('consent.given_at: дата согласия');
  return { crmId: id, phone, email, fullName, languages, qualification, version, givenAt };
}

async function importProfile(tx, p) {
  const link = await tx.one`select c.user_id, u.phone from crm_profiles c join users u on u.id = c.user_id where c.crm_id = ${p.crmId}`;
  let userId;
  let outcome;
  if (link) {
    // Телефон — это вход. Сменился в CRM — не переносим молча: иначе чужой номер получил бы этот профиль.
    if (link.phone !== p.phone) reject('телефон отличается от перенесённого ранее — сверить вручную');
    userId = link.user_id;
    outcome = 'updated';
  } else {
    const u = await tx.one`select id from users where phone = ${p.phone}`;
    if (u) {
      const other = await tx.one`select crm_id from crm_profiles where user_id = ${u.id}`;
      if (other) reject('этот телефон уже связан с другим профилем CRM');
      userId = u.id;
      outcome = 'linked';
    } else outcome = 'created';
  }
  const byEmail = await tx.one`select user_id from crm_profiles where email = ${p.email}`;
  if (byEmail && byEmail.user_id !== userId) reject('эта почта уже у другого профиля');
  if (!userId) userId = (await tx.one`insert into users (phone, full_name) values (${p.phone}, ${p.fullName}) returning id`).id;
  else if (p.fullName) await tx`update users set full_name = ${p.fullName} where id = ${userId} and full_name = ''`;
  await tx`
    insert into crm_profiles (user_id, crm_id, email, languages, qualification, consent_version, consent_at)
    values (${userId}, ${p.crmId}, ${p.email}, ${p.languages}, ${p.qualification}, ${p.version}, ${p.givenAt})
    on conflict (user_id) do update set email = ${p.email}, languages = ${p.languages}, qualification = ${p.qualification},
      consent_version = ${p.version}, consent_at = ${p.givenAt}, updated_at = now()`;
  // Профиль исполнителя Платформы — без допусков: дела на услуги Платформы даёт только допуск администратора (1.4).
  await tx`insert into specialists (user_id) values (${userId}) on conflict (user_id) do nothing`;
  return outcome;
}

export async function receiveProfiles(tx, data) {
  const list = listOf(data, 'profiles', LIMITS.profiles);
  const seen = { crm: new Set(), phone: new Set(), email: new Set() };
  const results = [];
  for (const rec of list) {
    const id = plainObject(rec) && typeof rec.crm_id === 'string' && CRM_ID_RE.test(rec.crm_id) ? rec.crm_id : null;
    try {
      const p = parseProfile(rec);
      if (seen.crm.has(p.crmId) || seen.phone.has(p.phone) || seen.email.has(p.email)) reject('повтор в сообщении');
      seen.crm.add(p.crmId); seen.phone.add(p.phone); seen.email.add(p.email);
      results.push({ crm_id: id, outcome: await importProfile(tx, p) });
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      results.push({ crm_id: id, outcome: 'rejected', reason: e.message });
    }
  }
  return { results, counts: tally(results) };
}

// ——— Загрузка: число текущих дел исполнителя в CRM ———

export async function receiveLoad(tx, data) {
  const list = listOf(data, 'loads', LIMITS.load);
  const results = [];
  for (const rec of list) {
    const id = plainObject(rec) && typeof rec.crm_id === 'string' && CRM_ID_RE.test(rec.crm_id) ? rec.crm_id : null;
    try {
      keysOnly(rec, ['crm_id', 'open_cases'], ['crm_id', 'open_cases']);
      crmId(rec.crm_id);
      if (!Number.isInteger(rec.open_cases) || rec.open_cases < 0 || rec.open_cases > 500) reject('open_cases: целое от 0 до 500');
      const done = await tx`
        with c as (update crm_profiles set load_at = now() where crm_id = ${rec.crm_id} returning user_id)
        update specialists s set external_load = ${rec.open_cases} from c where s.user_id = c.user_id returning 1`;
      results.push({ crm_id: id, outcome: done.length ? 'updated' : 'unknown' });
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      results.push({ crm_id: id, outcome: 'rejected', reason: e.message });
    }
  }
  return { results, counts: tally(results) };
}

// ——— Предложения госзаказа ———

function parseOffer(rec) {
  const closing = plainObject(rec) && rec.status === 'closed';
  keysOnly(rec, ['offer_id', 'crm_id', 'customer', 'language', 'deadline', 'volume', 'payment', 'status'],
    closing ? ['offer_id', 'crm_id', 'status'] : ['offer_id', 'crm_id', 'customer', 'language', 'deadline', 'volume', 'payment', 'status']);
  const offerId = crmId(rec.offer_id, 'offer_id');
  const id = crmId(rec.crm_id);
  if (closing) return { offerId, crmId: id, status: 'closed' };
  if (rec.status !== 'open') reject('status: open или closed');
  const customer = str(rec.customer, 'customer', 200);
  if (looksLikeCaseData(customer)) reject('customer: только название органа — без номера дела, фамилий, телефонов');
  const language = str(rec.language, 'language', 60);
  if (!LANGUAGE_RE.test(language)) reject('language: название языка буквами');
  if (typeof rec.deadline !== 'string' || !validDate(rec.deadline)) reject('deadline: дата ГГГГ-ММ-ДД');
  if (rec.deadline < todayMsk()) reject('deadline: срок уже прошёл');
  const v = rec.volume;
  if (!plainObject(v)) reject('volume: объём');
  keysOnly(v, ['amount', 'unit'], ['amount', 'unit']);
  if (!Number.isInteger(v.amount) || v.amount < 1 || v.amount > 1_000_000) reject('volume.amount: целое от 1');
  if (!(v.unit in VOLUME_UNITS)) reject(`volume.unit: одно из ${Object.keys(VOLUME_UNITS).join(', ')}`);
  // Платформа показывает только предложения с оплатой по Положению (ПП РФ № 1240); другой оплаты в мосте нет.
  if (rec.payment !== 'pp1240') reject('payment: только pp1240');
  return { offerId, crmId: id, status: 'open', customer, language, deadline: rec.deadline, amount: v.amount, unit: v.unit };
}

export async function receiveOffers(tx, data) {
  const list = listOf(data, 'offers', LIMITS.offers);
  const results = [];
  for (const rec of list) {
    const offerId = plainObject(rec) && typeof rec.offer_id === 'string' && CRM_ID_RE.test(rec.offer_id) ? rec.offer_id : null;
    const id = plainObject(rec) && typeof rec.crm_id === 'string' && CRM_ID_RE.test(rec.crm_id) ? rec.crm_id : null;
    try {
      const o = parseOffer(rec);
      const link = await tx.one`select user_id from crm_profiles where crm_id = ${o.crmId}`;
      if (!link) { results.push({ offer_id: offerId, crm_id: id, outcome: 'unknown' }); continue; }
      const cur = await tx.one`select status from crm_offers where offer_id = ${o.offerId} and user_id = ${link.user_id} for update`;
      if (o.status === 'closed') {
        if (!cur) { results.push({ offer_id: offerId, crm_id: id, outcome: 'unknown' }); continue; }
        await tx`update crm_offers set status = 'closed', updated_at = now() where offer_id = ${o.offerId} and user_id = ${link.user_id}`;
        results.push({ offer_id: offerId, crm_id: id, outcome: 'closed' });
        continue;
      }
      await tx`
        insert into crm_offers (offer_id, user_id, customer, language, deadline, volume_amount, volume_unit, status)
        values (${o.offerId}, ${link.user_id}, ${o.customer}, ${o.language}, ${o.deadline}, ${o.amount}, ${o.unit}, 'open')
        on conflict (offer_id, user_id) do update set customer = ${o.customer}, language = ${o.language}, deadline = ${o.deadline},
          volume_amount = ${o.amount}, volume_unit = ${o.unit}, status = 'open', updated_at = now()`;
      // Новое (или снова открытое) предложение — уведомление в кабинете и СМС по настройке «Предложения дел».
      if (cur?.status !== 'open') await notify(tx, 'crm_offer', { users: [link.user_id] });
      results.push({ offer_id: offerId, crm_id: id, outcome: cur ? (cur.status === 'open' ? 'updated' : 'reopened') : 'created' });
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      results.push({ offer_id: offerId, crm_id: id, outcome: 'rejected', reason: e.message });
    }
  }
  return { results, counts: tally(results) };
}

// Что видит исполнитель в кабинете: связан ли профиль с CRM, сколько дел в CRM, открытые предложения со ссылкой в CRM.
export async function crmView(sql, cfg, userId) {
  const link = await sql.one`
    select c.languages, c.qualification, c.load_at, s.external_load
    from crm_profiles c left join specialists s on s.user_id = c.user_id where c.user_id = ${userId}`;
  if (!link) return { linked: false, offers: [] };
  const offers = await sql`
    select offer_id, customer, language, deadline, volume_amount, volume_unit, received_at from crm_offers
    where user_id = ${userId} and status = 'open' and deadline >= ${todayMsk()} order by deadline, received_at`;
  return {
    linked: true,
    languages: link.languages,
    qualification: link.qualification,
    open_cases: link.external_load ?? 0,
    load_at: link.load_at,
    offers: offers.map((o) => ({
      offer_id: o.offer_id, customer: o.customer, language: o.language, deadline: o.deadline,
      volume: `${o.volume_amount} ${VOLUME_UNITS[o.volume_unit]}`, payment: 'Оплата по Положению (ПП РФ № 1240)',
      url: cfg.crm.url ? `${cfg.crm.url}/offers/${encodeURIComponent(o.offer_id)}` : null,
    })),
  };
}
