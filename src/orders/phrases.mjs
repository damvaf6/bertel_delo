// Готовые фразы исполнителя заказчику (задача 2.84): частые вопросы по делу — доступ на осмотр, уточнить адрес, срок
// документов. Нажатие подставляет текст в поле сообщения; исполнитель правит его и отправляет сам — программа ничего не
// отправляет за него. Подставляется только то, что заказчик и так видит в своей заявке (адрес, запрошенные документы).
// Что исследуют — объект, товар или документ — по `subject` услуги (src/modules/), как на странице осмотра (2.81, 2.82).

import { workdayBefore, workdayFrom } from './holidays.mjs';
import { addDays, todayMsk } from './workflow.mjs';

const NOUN = {
  object: { gen: 'объекта', where: 'объект' },
  goods: { gen: 'товара', where: 'товар' },
  car: { gen: 'автомобиля', where: 'автомобиль' },
  document: { gen: 'документа', where: 'документ' },
};

// Срок для заказчика (2.387): через 3 рабочих дня по Москве — не на выходной и не на праздник; при сроке дела — не позже
// чем за 2 рабочих дня до него (эксперту нужно время на документы), но не раньше следующего рабочего дня. Исполнитель
// меняет дату в тексте, если нужно. 'YYYY-MM-DD'.
export const DOCS_DUE_DAYS = 3;
export const DOCS_DUE_RESERVE = 2;
export function docsDueIso(now = new Date(), deadline = null) {
  const today = todayMsk(now);
  const first = workdayFrom(addDays(today, 1));
  let due = first;
  for (let i = 1; i < DOCS_DUE_DAYS; i++) due = workdayFrom(addDays(due, 1));
  if (deadline) {
    let limit = String(deadline).slice(0, 10);
    for (let i = 0; i < DOCS_DUE_RESERVE; i++) limit = workdayBefore(limit);
    if (limit < due) due = limit;
  }
  return due < first ? first : due;
}

// Дата 'YYYY-MM-DD' словами: «20 октября».
export const dayWords = (iso) => new Date(`${iso}T12:00:00Z`)
  .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

// def — услуга из реестра (registry.service), fields — поля заявки, openDocs — названия запрошенных и ещё не присланных
// документов (src/ops/docreq-ops.mjs), moved — последний согласованный перенос срока, пока он в силе (2.178):
// { from, to } — даты 'YYYY-MM-DD'; заказчик и так видит перенос в своей заявке. silent — заказчик 2 дня и дольше не отвечает
// на сообщение эксперта (2.375, src/orders/silence.mjs): { at, body } — тогда первой фразой «Напомнить о вопросе».
// deadline — срок дела 'YYYY-MM-DD': «пришлите до …» с запасом до него (2.387).
export function messagePhrases({ def, fields = {}, openDocs = [], moved = null, silent = null, deadline = null, now = new Date() }) {
  const subject = def?.service.subject ?? 'object';
  const n = NOUN[subject] ?? NOUN.object;
  const due = dayWords(docsDueIso(now, deadline));
  const out = [];
  if (silent) out.push(remindPhrase(silent));

  if (subject === 'document') {
    out.push({
      id: 'access', title: 'Передать оригинал',
      text: 'Здравствуйте! Для исследования нужен оригинал документа и образцы подписи (почерка). Подскажите, пожалуйста, '
        + 'когда и как Вам удобно их передать — лично или курьером, — и телефон для связи.',
    });
  } else {
    out.push({
      id: 'access', title: 'Доступ на осмотр',
      text: `Здравствуйте! Для работы нужен осмотр ${n.gen}. Подскажите, пожалуйста, удобные дату и время, `
        + 'кто обеспечит доступ (имя и телефон для связи) и нужен ли пропуск.'
        + (subject === 'goods' ? ' До осмотра, пожалуйста, не ремонтируйте и не разбирайте товар.' : '')
        + (subject === 'car' ? ' До осмотра, пожалуйста, не ремонтируйте автомобиль.' : ''),
    });
  }

  // Адрес — из заявки, если заказчик его указал: «в заявке указано …».
  const addrField = def?.fields.find((f) => ['address', 'location'].includes(f.id) && String(fields[f.id] ?? '').trim());
  const addr = addrField ? String(fields[addrField.id]).trim() : null;
  out.push({
    id: 'address', title: 'Уточнить адрес',
    text: subject === 'object'
      ? `Здравствуйте! Уточните, пожалуйста, адрес объекта${addr ? ` (в заявке указано: «${addr}»)` : ''}: `
        + 'подъезд, этаж, код домофона, как удобнее проехать.'
      : `Здравствуйте! Уточните, пожалуйста, где сейчас находится ${n.where}${addr ? ` (в заявке указано: «${addr}»)` : ''} `
        + 'и у кого — имя и телефон для связи.',
  });

  out.push({
    id: 'docs', title: 'Срок документов',
    text: openDocs.length
      ? `Здравствуйте! Для работы ещё нужны документы: ${openDocs.join('; ')}. Пришлите их, пожалуйста, до ${due} — `
        + 'приложить можно в деле, к каждому пункту списка «Запрошенные документы». Если какого-то документа нет — напишите.'
      : `Здравствуйте! Пришлите, пожалуйста, до ${due} документы: [какие]. Приложить можно в деле или ответом здесь. `
        + 'Если какого-то документа нет — напишите.',
  });

  if (moved) {
    out.push({
      id: 'deadline', title: 'Срок перенесён',
      text: `Здравствуйте! Срок по Вашей заявке перенесён на ${dayWords(moved.to)} (был ${dayWords(moved.from)}). `
        + 'Если появятся вопросы — напишите здесь.',
    });
  }
  return out;
}

// Напоминание о своём сообщении без ответа (2.375): когда писали и о чём — начало сообщения, без «Здравствуйте!».
export function remindPhrase({ at, body }) {
  const day = new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
  const what = String(body).replace(/^Здравствуйте!\s*/, '').replace(/\s+/g, ' ').trim();
  const short = what.length > 120 ? `${what.slice(0, 119)}…` : what;
  return {
    id: 'remind', title: 'Напомнить о вопросе',
    text: `Здравствуйте! Напоминаю о своём сообщении от ${day}: «${short}». Ответьте, пожалуйста, здесь, когда будет `
      + 'возможность, — без ответа работа по делу может задержаться.',
  };
}
