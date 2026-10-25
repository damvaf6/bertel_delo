// «Сегодня» (2.34): над списком дел — что требует внимания сейчас. Эксперту: горит по срокам, вернули на доработку, новые
// предложения, ждут проверки диспетчера. Руководителю экспертной организации — по делам его экспертов: горит срок, ждут
// подписи организации, вернул эксперту, ждут назначения (без данных заказчика), сроки документов досье экспертов (2.63),
// «горящие» — срок через 1–2 дня, а нет черновика или фото осмотра (2.98). Эксперту — очередь подписи организации (2.99).
// Эксперт не принимает дела, а срок его дела в эти дни (2.113) — передать коллеге.
// Напоминания по своим заметкам к делу (2.115). Заказчик ждёт ответа в переписке больше суток (2.132). Срок близко, а файла
// результата нет (2.138). «Вернули на доработку» — когда вернули и сколько осталось до срока (2.147).
// Руководитель не подписал 2 дня и дольше (2.152) — отдельной строкой с «Напомнить руководителю» прямо здесь.
// Ответ диспетчера на просьбу о переносе срока — до первого просмотра «Срока» в деле (2.155).
// Срок прошёл, а перенос не просили — «Попросить перенести срок» прямо в строке (2.166).
// Руководителю «Ждут подписи организации» — дольше всех ждущие первыми, 2 дня и дольше — красным (2.161).
// «Вернули эксперту» — с «Напомнить эксперту» прямо здесь (2.162).
// Отказали в переносе, а срок в дни «не принимаю дела» (2.215) — «Попросить руководителя передать дело» прямо в строке.
// Исправленный файл больше суток не подписан (2.204) — отдельной красной строкой, сразу к файлу.
// Выписка ЕГРН в деле старше 30 дней на дату оценки (2.224) — «Запросить свежую выписку» прямо в строке.
// Оценка для банка без задания на оценку, а срок близко (2.306) — «Запросить задание» прямо в строке.
// После ИИ-проверки пришёл запрошенный документ (2.248) — строка к ИИ-проверке в деле.
// Задание на оценку пришло позже черновика (2.295) — строка к таблице задания в черновике.
// Дело на проверке у диспетчера 2 дня и дольше (2.369) — отдельной строкой, без кнопок.
// «Можно продолжать» (2.86) — пришли документы, осмотр или сообщение. Диспетчеру (2.42) — деньги, проверка, цена, подбор, молчащие исполнители, горящие сроки. Нажатие — в дело или в раздел
// организации.
// Тексты — только через textContent.
import { api, el } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const since = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
// «Соберите Word заново» (2.272, 2.280): что заменено в черновике — по выписке ЕГРН, по заявке и заданию на оценку или и то и другое.
function rebuildWhat(x) {
  const swapped = x.swapped ?? [], fixed = x.fixed ?? [];
  const all = [...swapped, ...fixed];
  const how = !fixed.length ? 'заменено по выписке ЕГРН' : !swapped.length ? 'исправлено по заявке и заданию на оценку'
    : 'заменено по выписке ЕГРН и исправлено по заявке и заданию на оценку';
  return `В черновике ${how} ${since(x.draft_at)}${all.length > 1 ? ` (${all.length})` : ''}: ${all[0].length > 100 ? `${all[0].slice(0, 99)}…` : all[0]}`;
}
const waited = (iso) => {
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3600_000);
  return h < 1 ? 'меньше часа' : h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн.${h % 24 ? ` ${h % 24} ч` : ''}`;
};
const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')} ₽`;

function daysLeft(iso, today) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
}
function deadline(x, today) {
  if (!x.deadline) return 'срок не указан';
  const n = daysLeft(x.deadline, today);
  // Уже попросили перенести срок (2.100) — на какую дату, пока диспетчер не ответил.
  const ext = x.extend ? ` · ${x.who ?? 'просят'} перенести на ${dayRu(x.extend.new_deadline)}, ждёт ответа диспетчера` : '';
  if (x.overdue || n < 0) return `просрочено — срок был ${dayRu(x.deadline)}${ext}`;
  // Срок в выходной или праздник (2.382) — сдавать в последний рабочий день перед ним.
  const wb = x.work_before ? ` · нерабочий день — сдайте лучше до него, последний рабочий день — ${WD[new Date(`${x.work_before}T00:00:00Z`).getUTCDay()]}, ${dayRu(x.work_before)}` : '';
  return `${n === 0 ? 'срок сегодня' : n === 1 ? 'срок завтра' : `срок ${dayRu(x.deadline)} · осталось ${n} дн.`}${wb}${ext}`;
}

// Срок по заданию на оценку (2.304): сегодня, завтра, через N дн. или уже прошёл.
function taskDueWhen(d, today) {
  const n = daysLeft(d.day, today);
  return n < 0 ? `Срок по заданию прошёл — ${dayRu(d.day)}` : n === 0 ? `Срок по заданию сегодня — ${dayRu(d.day)}`
    : n === 1 ? `Срок по заданию завтра — ${dayRu(d.day)}` : `Срок по заданию ${dayRu(d.day)} · осталось ${n} дн.`;
}

// Срок по письму о переносе (2.341): сегодня, завтра или уже прошёл.
function letterDueWhen(d, doc) {
  const by = `Срок по ${doc.toLowerCase().replace(/^письмо/, 'письму').replace(/^определение/, 'определению')} о переносе`;
  return d.days_left < 0 ? `${by} прошёл — ${dayRu(d.day)}` : `${by} ${d.days_left === 0 ? 'сегодня' : 'завтра'} — ${dayRu(d.day)}`;
}

// Руководителю у дела на подписи (2.308): срок по заданию на оценку прошёл или сегодня — с файлом и страницей задания.
// 2.344: срок из письма о переносе — «срок по письму о переносе»; перенесён письмом на день позже сегодняшнего — «срок
// перенесён письмом на …» и каким он был (не красным: `taskDueSignClass`). 2.352: по письму о переносе завтра — «подпишите до …».
export const taskDueSignText = (d) => {
  const was = d.letter?.was ? ` · ${d.letter.was_letter ? 'по прежнему письму' : d.by} было ${dayRu(d.letter.was)}` : '';
  const by = d.letter ? 'по письму о переносе' : d.by;
  const head = d.moved ? `Срок перенесён письмом на ${dayRu(d.day)}${was}`
    : d.soon ? `Срок по письму о переносе завтра — подпишите до ${dayRu(d.day)}${was}`
    : d.overdue ? `Срок ${by} прошёл — ${dayRu(d.day)}${was}` : `Срок ${by} сегодня — подпишите сегодня${was}`;
  return `${head} («${d.name}», стр. ${d.page})`;
};
export const taskDueSignClass = (d) => (d.moved ? 'muted' : 'overdue');

// Руководителю (2.332 — «Дела экспертов», 2.334 — подпись и «Сегодня»): «Письма банка о переносе срока нет: срок дела
// перенесён на …, а по заданию на оценку отчёт ждут к …» и просил ли эксперт письмо у заказчика.
export function taskMovedText(m) {
  const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  // 2.335: письмо пришло, а срок в нём раньше согласованного срока дела — не «письма нет».
  if (m.letter) return `${m.doc} о переносе пришло, но срок в нём — ${dayRu(m.day)}, а срок дела перенесён на ${dayRu(m.deadline)}`;
  const doc = m.doc.replace(/^Письмо/, 'Письма').replace(/^Определение/, 'Определения');
  return `${doc} о переносе срока нет: срок дела перенесён на ${dayRu(m.deadline)}, а ${m.by} отчёт ждут к `
    + `${dayRu(m.day)}${m.asked ? ` · эксперт попросил письмо у заказчика ${since(m.asked)}` : ' · эксперт письмо у заказчика ещё не просил'}`;
}

// Сдать по письму о переносе (2.348, как у эксперта в «Сегодня» 2.341): когда, срок дела и просил ли эксперт письмо с новым
// сроком. Руководителю в «Делах экспертов» и в карточке эксперта (прогон 2.350); близко (прошёл или через 1–2 дня) — красным.
export function taskLetterLines(m) {
  const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const d = m.letter_due;
  const when = !d ? '' : d.overdue ? ', срок прошёл' : d.days_left === 0 ? ', сегодня' : d.days_left === 1 ? ', завтра' : '';
  const doc = m.doc.toLowerCase().replace(/^письмо/, 'письму').replace(/^определение/, 'определению');
  return [el('div', { class: d?.hot ? 'overdue' : 'muted', 'data-role': 'task-letter', text: `Сдать по ${doc} о переносе — к ${dayRu(m.day)}${when}` }),
    el('div', { class: 'muted', 'data-role': 'task-letter-why', text: `${taskMovedText(m)} · ${m.asked
      ? `эксперт попросил письмо с новым сроком ${since(m.asked)}` : 'эксперт письмо с новым сроком ещё не просил'}` })];
}

// Группа строк: заголовок с числом и строки-кнопки. Строка может быть { text, class } — например, красная (2.161).
// extra(x) — кнопки под строкой (2.166: «Попросить перенести срок» у просроченного дела).
function group(id, title, items, line, go, extra = () => []) {
  if (!items.length) return [];
  return [el('li', { class: 'group', 'data-today': id, text: `${title} · ${items.length}` }),
    ...items.map((x) => el('li', { 'data-today-item': id },
      el('button', { class: 'open', onclick: () => go(x) }, ...line(x).map((t, i) => (typeof t === 'string'
        ? el('div', { class: i ? 'muted' : 'title', text: t })
        : el('div', { class: t.class, ...(t.role ? { 'data-role': t.role } : {}), text: t.text })))),
      ...extra(x)))];
}

// Строка у дела в «Делах экспертов» руководителя (2.394).
export const newYearCaseText = (ny) => `Срок в новогодние каникулы (${dayRu(ny.from)} — ${dayRu(ny.to)}): заказчик и банк не работают — сдать до ${dayRu(ny.work_before)}`;

// Новогодние каникулы впереди (2.393): заголовок «Срок в новогодние каникулы — сдайте до 30 декабря» и дела под ним.
function newYear(ny, today, go) {
  if (!ny?.items?.length) return [];
  const wb = `${WD[new Date(`${ny.work_before}T00:00:00Z`).getUTCDay()]}, ${dayRu(ny.work_before)}`;
  return group('new-year', `Срок в новогодние каникулы — сдайте до ${dayRu(ny.work_before)}`, ny.items, (x) => [x.title,
    { class: 'warn-line', role: 'new-year-what', text: `срок ${dayRu(x.deadline)} — в каникулы (${dayRu(ny.from)} — ${dayRu(ny.to)}): заказчик и банк не работают, последний рабочий день — ${wb}` },
    `${x.service} · осталось до ${dayRu(ny.work_before)}: ${daysLeft(ny.work_before, today)} дн.`], go);
}

// Аттестат или полис эксперта организации кончается до 15 января (2.406): только эксперт, вид документа и срок, как
// «Документы экспертов: срок» (2.63); продлевает и вносит новый срок в досье сам эксперт.
function orgDossierNewYear(g, today, go) {
  const d = g.dossier_new_year;
  if (!d?.items?.length) return [];
  return group(`org-dossier-ny-${g.id}`, `Документы экспертов: продлить до каникул — до ${dayRu(d.by)}`, d.items, (x) => [
    `${x.expert} · ${x.kind_name}`,
    { class: x.expired ? 'overdue' : 'warn-line', role: 'org-dossier-ny-what', text: x.expired
      ? `срок истёк ${dayRu(x.valid_until)} — по оценке эксперт снят с подбора`
      : `действует до ${dayRu(x.valid_until)} — кончается в каникулы или сразу после них (${dayRu(d.from)} — ${dayRu(d.to)})` },
    `в каникулы страховщики и центр аттестации не работают — пусть эксперт продлит до ${dayRu(d.by)} (осталось ${daysLeft(d.by, today)} дн.)`], go);
}

// Аттестат или полис из досье кончается до 15 января (2.405): в декабре — «продлите до каникул», к досье в профиле.
function dossierNewYear(d, today) {
  if (!d?.items?.length) return [];
  const wb = `${WD[new Date(`${d.by}T00:00:00Z`).getUTCDay()]}, ${dayRu(d.by)}`;
  return group('dossier-new-year', `Досье: продлите до каникул — до ${dayRu(d.by)}`, d.items, (x) => [
    `${x.kind_name}${x.number ? ` № ${x.number}` : ''}`,
    { class: x.expired ? 'overdue' : 'warn-line', role: 'dossier-ny-what', text: x.expired
      ? `срок истёк ${dayRu(x.valid_until)} — без него Вас не подбирают на оценку`
      : `действует до ${dayRu(x.valid_until)} — кончается в каникулы или сразу после них (${dayRu(d.from)} — ${dayRu(d.to)})` },
    `в каникулы страховщики и центр аттестации не работают — продлите до ${wb} (осталось ${daysLeft(d.by, today)} дн.) и внесите новый срок в досье`],
  () => { location.hash = 'specialist&to=dossier'; });
}

// Срок прошёл, а перенос ещё не просили (2.166) — кнопка сразу к форме «Попросить перенести срок» в деле.
function askLate(x) {
  if (!x.overdue || x.extend) return [];
  return [el('button', { type: 'button', class: 'secondary', 'data-action': 'ask-late',
    onclick: () => { location.hash = `order=${x.id}&to=late`; } }, 'Попросить перенести срок')];
}

// «Продлить на 3 дня» (2.196): та же ссылка действует дольше — владельцу ничего заново отправлять не нужно.
function extendLink(x) {
  const msg = el('div', { class: 'muted', 'data-role': 'inspect-extend-msg' });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'inspect-extend' }, 'Продлить на 3 дня');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/orders/${x.id}/inspection/extend`, { link_id: x.link_id, days: 3 });
      msg.textContent = `Продлено: ссылка действует до ${since(r.expires_at)} — владелец снимает по той же ссылке`;
      btn.remove();
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  return [btn, msg];
}

// «Запросить свежую выписку» (2.224): запрос документов в деле — заказчику уведомление с пояснением, от какого числа старая.
function egrnFresh(x) {
  const msg = el('div', { class: 'muted', 'data-role': 'egrn-fresh-msg' });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'egrn-fresh' }, 'Запросить свежую выписку');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', `/api/orders/${x.id}/doc-requests`, { items: ['egrn'], fresh_egrn: true });
      msg.textContent = 'Запрошено — заказчику отправлено уведомление';
      btn.remove();
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  return [btn, msg];
}

// «Запросить задание у заказчика» (2.306): запрос документов в деле — заказчику уведомление.
function bankTaskAsk(x) {
  const msg = el('div', { class: 'muted', 'data-role': 'bank-task-msg' });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'bank-task-ask' }, 'Запросить задание у заказчика');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', `/api/orders/${x.id}/doc-requests`, { items: [x.bank_task.item_id] });
      msg.textContent = 'Запрошено — заказчику отправлено уведомление';
      btn.remove();
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  return [btn, msg];
}

// «Попросить письмо у заказчика» (2.326): запрос документов в деле — письмо банка (определение суда) о переносе срока.
function taskMoveAsk(x) {
  if (!x.can_ask) return [];
  const msg = el('div', { class: 'muted', 'data-role': 'task-move-msg' });
  // Письмо уже пришло, но срок в нём раньше согласованного (2.335, 2.341) — просим письмо с новым сроком.
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'task-move-ask' },
    x.task_moved?.letter ? 'Попросить письмо с новым сроком' : 'Попросить письмо у заказчика');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', `/api/orders/${x.id}/doc-requests`, { task_move: true });
      msg.textContent = 'Запрошено — заказчику отправлено уведомление';
      btn.remove();
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  return [btn, msg];
}

// Письмо о переносе попросили, а оно не пришло 3 дня (2.347): «Напомнить заказчику» у строки письма, раз в сутки по делу.
const askedRemind = (a) => (a?.remind ? ` · ждём ${a.remind.days} дн.${a.remind.reminded_at ? `, напоминали ${since(a.remind.reminded_at)}` : ', заказчику ещё не напоминали'}` : '');
const letterActions = (x) => [...taskMoveAsk(x), ...(x.task_moved.asked?.remind?.can_remind ? docsRemind(x) : [])];

// Что пришло после ИИ-проверки (2.248): название документа и файл.
const recheckDocs = (docs) => docs.map((d) => `${d.title} («${d.filename}»)`).join(', ');

// «Напомнить заказчику» (2.234): запрошенное не пришло 3 дня — напоминание заказчику одной кнопкой, снова — завтра.
// Напомнить заказчику о своём сообщении (2.375): к переписке в деле с готовой фразой в поле — программа ничего не отправляет.
function silentRemind(x) {
  return [el('button', { type: 'button', class: 'secondary', 'data-action': 'silent-remind',
    onclick: () => { location.hash = `order=${x.id}&to=remind`; } }, 'Напомнить заказчику')];
}

function docsRemind(x) {
  const msg = el('div', { class: 'muted', 'data-role': 'docs-remind-msg' });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'docs-remind' }, 'Напомнить заказчику');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', `/api/orders/${x.id}/doc-requests/remind`);
      msg.textContent = 'Напомнили — заказчику отправлено уведомление; снова можно завтра';
      btn.remove();
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
  return [btn, msg];
}

// «Руководитель ещё не подписал» (2.152): строка ведёт к блоку подписи в деле, рядом — «Напомнить руководителю» (раз в сутки).
function signLate(items) {
  if (!items.length) return [];
  return [el('li', { class: 'group', 'data-today': 'sign-late', text: `Руководитель ещё не подписал · ${items.length}` }),
    ...items.map((x) => {
      const msg = el('div', { class: 'muted', 'data-role': 'sign-late-msg' });
      const remind = el('button', { type: 'button', class: 'secondary', 'data-action': 'sign-late-remind' }, 'Напомнить руководителю');
      remind.onclick = async () => {
        remind.disabled = true;
        try {
          await api('POST', `/api/orders/${x.id}/sign-reminder`);
          msg.textContent = 'Руководителю отправлено напоминание';
          remind.remove();
        } catch (err) { msg.textContent = err.message; remind.disabled = false; }
      };
      return el('li', { 'data-today-item': 'sign-late' },
        el('button', { class: 'open', onclick: () => { location.hash = `order=${x.id}&to=sign`; } },
          ...[x.title, `${x.org} · ${x.files === 1 ? 'файл' : `файлов ${x.files}`} · Вы подписали ${since(x.since)} — ждёт ${waited(x.since)}`,
            x.reminded_at ? `напоминали ${since(x.reminded_at)}${x.can_remind ? '' : ' · снова — завтра'}` : 'руководителю ещё не напоминали']
            .map((t, i) => el('div', { class: i ? 'muted' : 'title', text: t }))),
        ...(x.can_remind ? [remind] : []), msg);
    })];
}

// «Вернули эксперту — ждём исправления» у руководителя (2.162): строка ведёт к делу в «Делах экспертов», рядом —
// «Напомнить эксперту» (раз в сутки, как там, 2.125). Номер дела в «Сегодня» — короткий; полный берём из «Дел экспертов».
function orgReturned(g, caseLine, go) {
  const items = g.returned ?? [];
  if (!items.length) return [];
  const id = `org-returned-${g.id}`;
  return [el('li', { class: 'group', 'data-today': id, text: `Вернули эксперту — ждём исправления · ${items.length}` }),
    ...items.map((x) => {
      const r = x.remind;
      const msg = el('div', { class: 'muted', 'data-role': 'returned-remind-msg' });
      const remind = el('button', { type: 'button', class: 'secondary', 'data-action': 'returned-remind' }, 'Напомнить эксперту');
      remind.onclick = async () => {
        remind.disabled = true;
        try {
          const ref = x.order_ref.slice(2).toLowerCase();
          const c = (await api('GET', `/api/orgs/${g.id}/cases`)).cases.find((k) => k.id.startsWith(ref));
          if (!c) throw new Error('Дело не найдено — обновите страницу');
          await api('POST', `/api/orgs/${g.id}/cases/${c.id}/remind`);
          msg.textContent = 'Эксперту отправлено напоминание';
          remind.remove();
          // Строка «ещё не напоминали» больше не верна (2.170) — сразу «напоминали сегодня».
          const state = li.querySelector('[data-role="returned-remind-state"]');
          if (state) state.textContent = `напоминали ${since(new Date().toISOString())} · снова — завтра`;
        } catch (err) { msg.textContent = err.message; remind.disabled = false; }
      };
      const lines = [...caseLine(x), `замечание: ${x.comment}`,
        [x.at ? `вернули ${since(x.at)} — ${waited(x.at)} назад` : null,
          x.points ? (x.left ? `эксперт отметил исправленными ${x.points - x.left} из ${x.points}` : `эксперт отметил исправленным всё (${x.points} из ${x.points}) — ждём его подписи`) : null]
          .filter(Boolean).join(' · '),
        // Эксперт уже загрузил исправленный файл (2.170) — осталось его подписать; напоминать, может, и не нужно.
        x.fresh_file ? `эксперт загрузил исправленный файл ${since(x.fresh_file.at)} — ещё не подписал` : null,
        r ? (r.reminded_at ? `напоминали ${since(r.reminded_at)}${r.can_remind ? '' : ' · снова — завтра'}` : 'эксперту ещё не напоминали') : null]
        .filter(Boolean);
      const li = el('li', { 'data-today-item': id },
        el('button', { class: 'open', onclick: () => go(x) }, ...lines.map((t, i) => el('div', {
          class: i ? 'muted' : 'title', text: t, ...(r && i === lines.length - 1 ? { 'data-role': 'returned-remind-state' } : {}) }))),
        ...(r?.can_remind ? [remind] : []), msg);
      return li;
    })];
}

export async function loadToday() {
  const box = $('today-box');
  let t;
  try { t = await api('GET', '/api/today'); } catch { box.classList.add('hidden'); return; }
  const toOrder = (x) => { location.hash = `order=${x.id}`; };
  const rows = [];
  const e = t.expert;
  if (e) {
    // Срок через 1–2 дня или прошёл, а своего файла результата нет (2.138) — первой группой; в «Горит срок» не повторяется.
    const noResult = e.no_result ?? [];
    const taskDue = e.task_due ?? [];
    rows.push(
      // Срок по заданию на оценку раньше срока дела и близко (2.304) — выше «Срок близко»; по сроку дела ещё можно успеть,
      // а по заданию (письму банка, определению суда) — нет. Перенос у диспетчера срок задания не двигает — кнопки нет.
      ...group('task-due', 'Срок по заданию на оценку близко', taskDue, (x) => [x.title,
        { class: 'overdue', role: 'task-due-when', text: `${taskDueWhen(x.task_due, t.today)} (${x.task_due.by}: «${x.task_due.name}», стр. ${x.task_due.page}) — раньше срока дела` },
        `${x.service} · ${deadline(x, t.today)}`,
        x.has_draft ? 'черновик есть — соберите отчёт Word и загрузите файл' : 'загрузите файл результата к сроку по заданию'],
      (x) => { location.hash = `order=${x.id}&to=result`; }),
      // В загруженном и ещё не подписанном файле дата составления позже срока по заданию на оценку (2.321) — до подписи:
      // исправить дату или приложить документ о переносе срока; нажатие ведёт к файлу результата.
      // Письмо о переносе пришло, а срок в нём раньше согласованного (2.335) — сегодня, завтра или прошёл, файла результата нет
      // (2.341): сдать по письму; нажатие — к файлу результата, кнопка — попросить письмо с новым сроком.
      ...group('letter-due', 'Сдать по письму о переносе', e.letter_due ?? [], (x) => [x.title,
        { class: 'overdue', role: 'letter-due-when', text: `${letterDueWhen(x.letter_due, x.task_moved.doc)} («${x.task_moved.name}», стр. ${x.task_moved.page})` },
        `срок дела перенесён на ${dayRu(x.task_moved.deadline)}, а ${x.task_moved.who.toLowerCase()} ждёт отчёт по письму — к ${dayRu(x.letter_due.day)}`,
        x.can_ask ? (x.has_draft ? 'черновик есть — соберите отчёт Word и загрузите файл или попросите письмо с новым сроком'
          : 'загрузите файл результата или попросите письмо с новым сроком')
          : `письмо с новым сроком попросили ${since(x.task_moved.asked.at)} — пока его нет, сдайте по прежнему письму${askedRemind(x.task_moved.asked)}`],
      (x) => { location.hash = `order=${x.id}&to=result`; }, letterActions),
      // То же письмо, а свой файл результата загружен и не подписан (2.351) — «Подпишите до …»; нажатие — к этому файлу.
      ...group('letter-sign', 'Подпишите до срока по письму о переносе', e.letter_sign ?? [], (x) => [x.title,
        { class: 'overdue', role: 'letter-sign-when', text: `${x.letter_due.overdue ? 'Подпишите сегодня' : `Подпишите до ${dayRu(x.letter_due.day)}`} · ${letterDueWhen(x.letter_due, x.task_moved.doc).toLowerCase()} («${x.task_moved.name}», стр. ${x.task_moved.page})` },
        { class: 'muted', role: 'letter-sign-file', text: `«${x.file.filename}» загружен ${since(x.file.at)} — не подписан` },
        `срок дела перенесён на ${dayRu(x.task_moved.deadline)}, а ${x.task_moved.who.toLowerCase()} ждёт отчёт по письму — к ${dayRu(x.letter_due.day)}`,
        x.can_ask ? 'подпишите файл или попросите письмо с новым сроком'
          : `письмо с новым сроком попросили ${since(x.task_moved.asked.at)} — пока его нет, подпишите к сроку по прежнему письму${askedRemind(x.task_moved.asked)}`],
      (x) => { location.hash = `order=${x.id}&to=unsigned`; }, letterActions),
      ...group('task-made', 'Дата составления позже срока по заданию на оценку', e.task_made ?? [], (x) => [x.title,
        // 2.357: срок из письма о переносе — так и назван; совет — письмо с новым сроком (письмо о переносе уже в деле).
        { class: 'overdue', role: 'task-made-why', text: `В «${x.file}» дата составления — ${dayRu(x.made.day)} (стр. ${x.made.page}), а срок ${x.letter ? 'по письму о переносе' : x.task_due.by} — ${dayRu(x.task_due.day)} («${x.task_due.name}», стр. ${x.task_due.page})` },
        // Прогон 2.360: письмо с новым сроком уже попросили — не советуем просить снова.
        x.letter?.asked_at ? `до подписи исправьте дату составления — письмо с новым сроком попросили ${since(x.letter.asked_at)}, пока его нет`
          : x.letter ? 'до подписи исправьте дату составления или попросите у заказчика письмо с новым сроком'
          : 'до подписи исправьте дату составления или приложите к делу документ о переносе срока'],
      (x) => { location.hash = `order=${x.id}&to=result`; }),
      ...group('no-result', 'Срок близко — нет файла результата', noResult, (x) => [x.title, `${x.service} · ${deadline({ ...x, who: 'Вы попросили' }, t.today)}`,
        // Перенос уже попросили (2.140) — второй раз не предлагаем.
        x.has_draft ? 'черновик есть — соберите отчёт Word и загрузите файл'
          : x.extend ? 'загрузите файл результата' : 'загрузите файл результата или попросите перенести срок'],
      (x) => { location.hash = `order=${x.id}&to=result`; }, askLate),
      // Диспетчер отказал в переносе, а срок в дни, когда эксперт не принимает дела (2.215) — попросить руководителя передать
      // дело коллеге: дело открывается на просьбе руководителю (поле причины в фокусе, как в «Моих сроках» — 2.195).
      ...group('away-declined', 'Отказали в переносе — срок в дни, когда Вы не принимаете дела', e.away_declined ?? [], (x) => [x.title,
        { class: 'overdue', role: 'away-declined-why', text: `Диспетчер отказал в переносе на ${dayRu(x.asked)} — ${deadline(x, t.today)}, а Вы не принимаете дела до ${dayRu(x.away_until)}` },
        x.answer ? `пояснение: ${x.answer}` : `ответил ${since(x.decided_at)}`],
      (x) => { location.hash = `order=${x.id}&to=deadline`; },
      (x) => [el('button', { type: 'button', class: 'secondary', 'data-action': 'away-handover',
        onclick: () => { location.hash = `order=${x.id}&to=handover`; } }, 'Попросить руководителя передать дело')]),
      // Перенос согласован, а новый срок позже срока по заданию на оценку (2.326) — к блоку «Срок» в деле, кнопка — попросить
      // письмо о переносе у заказчика сразу.
      ...group('task-moved', 'Приложите письмо о переносе срока', e.task_moved ?? [], (x) => [x.title,
        { class: 'overdue', role: 'task-moved-why', text: `Срок перенесён на ${dayRu(x.task_moved.deadline)}, а ${x.task_moved.by} отчёт ждут к ${dayRu(x.task_moved.day)}` },
        x.task_moved.letter ? `${x.task_moved.doc.toLowerCase()} о переносе пришло, но срок в нём раньше — сдайте к ${dayRu(x.task_moved.day)} или попросите письмо с новым сроком`
          : x.task_moved.asked?.came ? 'документ от заказчика пришёл, но нового срока в нём не видно'
            : x.task_moved.asked ? `${x.task_moved.doc.toLowerCase()} о переносе попросили ${since(x.task_moved.asked.at)} — не пришло${askedRemind(x.task_moved.asked)}`
              : `нужно: ${x.task_moved.doc.toLowerCase()} о переносе срока`],
      (x) => { location.hash = `order=${x.id}&to=deadline`; }, letterActions),
      // Диспетчер ответил на просьбу о переносе срока (2.155) — пока эксперт не открыл «Срок» в деле.
      ...group('extend-answer', 'Ответ на просьбу о переносе срока', e.extend_answer ?? [], (x) => [x.title,
        x.outcome === 'approved' ? `Диспетчер согласился: срок перенесён на ${dayRu(x.new_deadline)} (был ${dayRu(x.old_deadline)})`
          : `Диспетчер отказал в переносе на ${dayRu(x.new_deadline)} — срок прежний, ${dayRu(x.old_deadline)}`,
        x.answer ? `пояснение: ${x.answer}` : `ответил ${since(x.decided_at)}`],
      (x) => { location.hash = `order=${x.id}&to=deadline`; }),
      ...signLate((e.sign_wait ?? []).filter((x) => x.long)),
      // Исправленный файл после возврата руководителя больше суток не подписан (2.204) — сразу к этому файлу в «Документах»;
      // в «Вернули на доработку» такое дело не повторяется.
      ...group('fresh-late', 'Исправленный файл не подписан', e.fresh_late ?? [], (x) => [x.title,
        { class: 'overdue', role: 'fresh-late-since', text: `«${x.fresh_file.filename}» загружен ${since(x.fresh_file.at)} — не подписан ${waited(x.fresh_file.at)}` },
        `${x.by} ждёт подписи, чтобы подписать от организации · ${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=fresh`; }),
      // Выписка ЕГРН старше 30 дней на дату оценки (2.224) — строка к запросу документов в деле, кнопка — запросить сразу.
      ...group('egrn-old', 'Выписка ЕГРН устарела', e.egrn_old ?? [], (x) => [x.title,
        { class: 'overdue', role: 'egrn-old-why', text: `«${x.egrn.name}» от ${dayRu(x.egrn.day)} — старше 30 дней на ${x.egrn.on_value ? `дату оценки ${dayRu(x.egrn.on)}` : 'сегодня'}` },
        deadline(x, t.today)],
      (x) => { location.hash = `order=${x.id}&to=docs`; }, egrnFresh),
      // Оценка для банка, задания на оценку нет и не запрошено, а срок через 3 дня или меньше (2.306) — без задания банк
      // отчёт может не принять; строка к запросу документов в деле, кнопка — запросить сразу.
      ...group('bank-task', 'Запросите задание на оценку от банка', e.bank_task ?? [], (x) => [x.title,
        { class: 'overdue', role: 'bank-task-why', text: `Оценка для банка, а задания на оценку в деле нет и его не запрашивали — ${deadline(x, t.today)}` },
        'по заданию сверяются дата оценки, вид стоимости и адрес'],
      (x) => { location.hash = `order=${x.id}&to=docs`; }, bankTaskAsk),
      // Запрошенные документы не пришли 3 дня (2.234) — строка к запросу документов в деле, кнопка — напомнить сразу.
      ...group('docs-wait', 'Документы не пришли', e.docs_wait ?? [], (x) => [x.title,
        { class: 'overdue', role: 'docs-wait-what', text: `Ждём ${waited(x.wait.since)}: ${x.wait.titles.join(', ')}` },
        x.wait.reminded_at ? `напоминали ${since(x.wait.reminded_at)} · можно напомнить снова` : 'заказчику ещё не напоминали'],
      (x) => { location.hash = `order=${x.id}&to=docs`; }, docsRemind),
      // После ИИ-проверки пришли запрошенные документы (2.248) — к ИИ-проверке в деле: проверить заново.
      ...group('ai-recheck', 'Пришли документы после ИИ-проверки', e.ai_recheck ?? [], (x) => [x.title,
        { class: 'warn-line', role: 'ai-recheck-what', text: `${recheckDocs(x.recheck.docs)} — пришло после ИИ-проверки ${since(x.recheck.review_at)}` },
        `${x.recheck.egrn ? 'проверьте заново: ИИ сверит отчёт с новой выпиской' : 'проверьте заново: ИИ увидит и эти документы'} · ${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=review`; }),
      // Задание на оценку пришло позже черновика, а в таблице задания — другое (2.295): к таблице задания в черновике.
      ...group('task-late', 'Задание пришло позже черновика — сверьте таблицу задания', e.task_late ?? [], (x) => [x.title,
        { class: 'warn-line', role: 'task-late-what', text: x.items.map((i) => `${i.label}: по заданию — ${i.v}${i.was ? `, в черновике — ${i.was}` : ', в черновике нет'}`).join(' · ') },
        `«${x.docs.join('», «')}» приложено ${since(x.doc_at)} — после черновика · ${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=task`; }),
      // В ИИ-проверке неподписанного файла остались расхождения с выпиской ЕГРН, которые можно заменить в черновике (2.266) —
      // к ИИ-проверке в деле, там «Заменить всё по выписке».
      ...group('egrn-swap', 'Можно заменить по выписке ЕГРН', e.egrn_swap ?? [], (x) => [x.title,
        { class: 'warn-line', role: 'egrn-swap-what', text: `${x.swap.length > 1 ? `Расхождений с выпиской: ${x.swap.length} — ` : ''}${x.swap[0].length > 120 ? `${x.swap[0].slice(0, 119)}…` : x.swap[0]}` },
        `замените в черновике, соберите Word заново и загрузите — тогда подписывайте · ${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=review`; }),
      // То же по заданию на оценку (письму, определению суда; 2.284) — к ИИ-проверке в деле, там «Заменить всё по заданию».
      ...group('task-swap', 'Можно заменить по заданию на оценку', e.task_swap ?? [], (x) => [x.title,
        { class: 'warn-line', role: 'task-swap-what', text: `${x.swap.length > 1 ? `Расхождений с заданием: ${x.swap.length} — ` : ''}${x.swap[0].length > 120 ? `${x.swap[0].slice(0, 119)}…` : x.swap[0]}` },
        `замените в черновике, соберите Word заново и загрузите — тогда подписывайте · ${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=review`; }),
      // Заменил по выписке ЕГРН (2.272) или исправил по заявке и заданию на оценку (2.280) в черновике, а файл результата собран
      // до замены — к кнопке сборки Word в деле.
      ...group('egrn-rebuild', 'Соберите Word заново', e.egrn_rebuild ?? [], (x) => [x.title,
        { class: 'warn-line', role: 'egrn-rebuild-what', text: rebuildWhat(x) },
        `«${x.file}» собран до замены — соберите Word заново и подпишите его · ${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=rebuild`; }),
      // Можно продолжать (2.86): пришло новое после того, как эксперт открывал дело, — сразу к переписке, документам или осмотру.
      ...group('ready', 'Можно продолжать', e.ready ?? [], (x) => [x.title, `${x.what.join(' · ')} · ${since(x.at)}`, deadline(x, t.today)],
        (x) => { location.hash = `order=${x.id}&to=${x.to}`; }),
      // Заказчик ждёт ответа больше суток (2.132) — сразу к переписке в деле.
      ...group('reply-wait', 'Заказчик ждёт ответа', e.reply_wait ?? [], (x) => [x.title,
        `«${x.last}»${x.count > 1 ? ` · сообщений без ответа: ${x.count}` : ''}`,
        `написал ${since(x.since)} — ждёт ${waited(x.since)}`],
      (x) => { location.hash = `order=${x.id}&to=chat`; }),
      // Заказчик 2 дня и дольше не отвечает на сообщение эксперта (2.375) — к переписке в деле, «Напомнить заказчику» сразу
      // подставляет готовую фразу-напоминание в поле сообщения; отправляет эксперт сам.
      ...group('customer-silent', 'Заказчик не отвечает', e.customer_silent ?? [], (x) => [x.title,
        { class: 'warn-line', role: 'customer-silent-what', text: `Вы написали ${since(x.since)}: «${x.last}» — ответа нет ${waited(x.since)}` },
        `${x.count > 1 ? `сообщений без ответа: ${x.count} · ` : ''}${deadline(x, t.today)}`],
      (x) => { location.hash = `order=${x.id}&to=chat`; }, silentRemind),
      // Свои заметки к делу (2.115): настал день напоминания — к заметкам в деле, там «Сделано».
      ...group('notes', 'Напоминания по заметкам', e.notes ?? [], (x) => [x.title, x.note,
        x.remind_on < t.today ? `напомнить было ${dayRu(x.remind_on)}` : 'напомнить сегодня'],
      (x) => { location.hash = `order=${x.id}&to=notes`; }),
      // Очередь подписи (2.99): подписал, организация ещё нет — к блоку в деле с кнопкой «Напомнить руководителю».
      ...group('sign-wait', 'Ждут подписи организации', (e.sign_wait ?? []).filter((x) => !x.long), (x) => [x.title,
        `${x.org} · ${x.files === 1 ? 'файл' : `файлов ${x.files}`} · Вы подписали ${since(x.since)} — ждёт ${waited(x.since)}`,
        x.reminded_at ? `напоминали ${since(x.reminded_at)}${x.can_remind ? ' · можно напомнить снова' : ''}` : 'можно напомнить руководителю'],
      (x) => { location.hash = `order=${x.id}&to=sign`; }),
      // Когда вернули и сколько осталось до срока (2.147); у замечания руководителя — сколько пунктов ещё не исправлено.
      // Нажатие — к файлу результата (диспетчер) или к замечаниям по пунктам (руководитель).
      ...group('returned', 'Вернули на доработку', e.returned, (x) => [x.title, `${x.by}: ${x.comment || 'без пояснения'}`,
        [x.at ? `вернули ${since(x.at)} — ${waited(x.at)} назад` : null,
          x.points ? (x.left ? `не исправлено пунктов: ${x.left} из ${x.points}` : 'все пункты отмечены — подпишите файл заново') : null]
          .filter(Boolean).join(' · '),
        // Исправленный файл уже загружен (2.170): осталось подписать — как в «Замечаниях руководителя» в деле (2.163).
        x.fresh_file ? `исправленный файл «${x.fresh_file.filename}» загружен — ждёт Вашей подписи` : null,
        deadline(x, t.today)].filter(Boolean),
      (x) => { location.hash = x.to ? `order=${x.id}&to=${x.to}` : `order=${x.id}`; }),
      // Осмотр по ссылке 2 дня без фото (2.85) — сразу к осмотру в деле, там «Отправить ссылку снова».
      ...group('inspect-silent', 'Осмотр: 2 дня нет фото', e.inspect_silent ?? [], (x) => [x.title,
        `ссылка от ${since(x.link_at)}${x.expired ? ' — срок истёк' : ''}${x.sms_to ? ` · СМС на ${x.sms_to}` : ''} · отправьте снова`],
      (x) => { location.hash = `order=${x.id}&to=inspect`; }),
      // Ссылка на осмотр перестанет действовать в ближайшие сутки, а «Готово» не нажато (2.196): продлить прямо здесь — владелец
      // снимает по той же ссылке; нажатие на строку — к осмотру в деле.
      ...group('inspect-expiring', 'Осмотр: ссылка скоро перестанет действовать', e.inspect_expiring ?? [], (x) => [x.title,
        `ссылка действует до ${since(x.expires_at)} · владелец не нажал «Готово» · ${x.photos ? `фото по ссылке: ${x.photos}` : 'фото пока нет'}${x.sms_to ? ` · СМС на ${x.sms_to}` : ''}`],
      (x) => { location.hash = `order=${x.id}&to=inspect`; }, extendLink),
      // Владелец нажал «Готово», а обязательные шаги осмотра без фото (2.208) — к осмотру в деле, там «Попросить доснять».
      ...group('inspect-incomplete', 'Осмотр: владелец нажал «Готово», а снял не всё', e.inspect_incomplete ?? [], (x) => [x.title,
        `«Готово» ${since(x.finished_at)} · не снято: ${x.missing.join(', ')}`,
        x.asked === x.missing.length ? 'просьба доснять готова — отправьте владельцу новую ссылку' : 'попросите доснять — владельцу уйдёт новая ссылка'],
      (x) => { location.hash = `order=${x.id}&to=inspect`; }),
      // За две недели до новогодних каникул (2.393) — дела со сроком в каникулы одной группой: заказчик и банк в каникулы не
      // принимают, сдать — до последнего рабочего дня перед ними.
      ...newYear(e.new_year, t.today, toOrder),
      // В декабре — аттестат или полис кончается до 15 января (2.405): продлить до каникул, иначе после них не подбирают на оценку.
      ...dossierNewYear(e.dossier_new_year, t.today),
      ...group('hot', 'Горит срок', e.hot.filter((x) => !noResult.some((n) => n.id === x.id) && !taskDue.some((n) => n.id === x.id)), (x) => [x.title, `${x.service} · ${deadline({ ...x, who: 'Вы попросили' }, t.today)}`], toOrder, askLate),
      ...group('offers', 'Новые предложения', e.offers, (x) => [x.title, [x.service, x.fee_kop ? `Вам ${rub(x.fee_kop)}` : null, deadline(x, t.today)].filter(Boolean).join(' · ')], toOrder),
      // На проверке у диспетчера 2 рабочих дня и дольше (2.369, 2.384) — строкой, без кнопок: делать ничего не нужно, ответ придёт в ленту.
      ...group('review-long', 'Диспетчер проверяет дольше 2 рабочих дней', e.review_long ?? [], (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`,
        { class: 'warn-line', role: 'review-long-what', text: `Сдано на проверку ${since(x.review_since)} · ждёт ${waited(x.review_since)} — ответ диспетчера придёт в уведомления` }], toOrder),
      ...group('review', 'Ждут проверки диспетчера', e.review, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
    );
  }
  const d = t.dispatcher;
  if (d) {
    const MONEY = { payout: 'Выплата исполнителю не прошла', refund: 'Возврат заказчику не прошёл', payment: 'Оплата висит больше суток' };
    rows.push(
      ...group('d-money', 'Деньги', d.money, (x) => [x.title, [MONEY[x.what], x.failure].filter(Boolean).join(': ')], toOrder),
      // Перенос срока (2.91) — сразу к блоку «Срок» в деле: согласиться или отказать.
      ...group('d-extend', 'Просят перенести срок', d.extend ?? [], (x) => [x.title, `${deadline(x, t.today)} → просят ${dayRu(x.new_deadline)}`, `${x.org_name ? `просит организация «${x.org_name}» — передать дело некому · ` : ''}причина: ${x.reason}`],
        (x) => { location.hash = `order=${x.id}&to=deadline`; }),
      ...group('d-review', 'Ждут проверки результата', d.review, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
      ...group('d-price', 'Назначить цену', d.price, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
      ...group('d-match', 'Подобрать исполнителя (оплачено)', d.to_match, (x) => [x.title, x.reason !== undefined ? `Снова в подборе: ${x.reason || 'без причины'}` : x.service, deadline(x, t.today)], toOrder),
      ...group('d-slow', 'Исполнитель не ответил больше суток', d.slow_offers, (x) => [x.title, `предложено ${since(x.offered_at)} · ${deadline(x, t.today)}`], toOrder),
      ...group('d-hot', 'Горит срок', d.hot, (x) => [x.title, `${x.status_name} · ${deadline(x, t.today)}`], toOrder),
    );
  }
  for (const g of t.orgs) {
    // Сразу к делу в разделе организации (2.67): назначить, подписать или само дело в «Делах экспертов».
    // Прогон 2.220: почему эксперт просит передать дело и есть ли кому передать — без открытия дела.
    const handoverWhy = (x) => {
      const text = [x.away_until ? `срок в дни, когда эксперт не принимает дела (до ${dayRu(x.away_until)})` : null,
        x.extend_declined ? 'диспетчер отказал в переносе срока' : null,
        x.can_transfer ? null : 'передать некому — нет другого эксперта с допуском к этой услуге'].filter(Boolean).join(' · ');
      return text ? [{ class: x.can_transfer ? 'muted' : 'overdue', role: 'handover-why', text }] : [];
    };
    const toOrg = (to) => (x) => {
      location.hash = x?.order_ref ? `org=${g.id}&case=${x.order_ref.slice(2)}&to=${to}` : `org=${g.id}`;
    };
    const caseLine = (x) => [`${x.service} · ${x.order_ref}`, [x.expert, deadline({ ...x, who: 'эксперт просит' }, t.today)].filter(Boolean).join(' · ')];
    // «Горящие» (2.98) — сразу после просьб передать дело; в «Горит срок у экспертов» они не повторяются.
    const risky = new Set((g.at_risk ?? []).map((x) => x.order_ref));
    // Строка дела на подписи организации (2.160, 2.161): когда эксперт подписал, сколько ждёт, что осталось по ИИ-проверке.
    const signLine = (x) => [...caseLine(x), {
        class: x.long ? 'overdue' : 'muted', role: 'sign-since',
        text: [`файлов: ${x.files}`, x.since ? `эксперт подписал ${since(x.since)} — ждёт ${waited(x.since)}` : null,
          x.reminded_at ? `эксперт напомнил ${since(x.reminded_at)}` : null].filter(Boolean).join(' · ') },
        // После возврата расхождение с выпиской осталось в новой ИИ-проверке эксперта (2.257) — красным.
        ...(x.egrn_kept ? [{ class: 'overdue', role: 'egrn-kept', text: `после возврата расхождение с выпиской ЕГРН осталось: ${x.egrn_kept} ${x.egrn_kept === 1 ? 'пункт' : x.egrn_kept < 5 ? 'пункта' : 'пунктов'}` }] : []),
        // В ИИ-проверке эксперта остались расхождения с заявкой или заданием на оценку (2.286, как отбор 2.276).
        ...(x.order_diff ? [{ class: 'overdue', role: 'order-diff', text: `расхождения с заявкой или заданием на оценку: ${x.order_diff} ${x.order_diff === 1 ? 'пункт' : x.order_diff < 5 ? 'пункта' : 'пунктов'}` }] : []),
        // Срок по заданию на оценку прошёл или сегодня (2.308) — красным.
        ...(x.task_due && (!x.task_moved || (x.task_moved.letter && !x.task_due.moved)) ? [{ class: taskDueSignClass(x.task_due), role: 'task-due-sign', text: taskDueSignText(x.task_due) }] : []),
        // Перенос согласован позже срока по заданию, а письма о переносе нет (2.334) — вместо строки срока по заданию.
        ...(x.task_moved ? [{ class: 'overdue', role: 'task-moved-sign', text: `До подписи: ${taskMovedText(x.task_moved)}` }] : [])];
    const part = [
      // Эксперт просит передать дело коллеге (2.107) — к делу в «Делах экспертов»: «Передать» или «Отказать».
      ...group(`org-handover-${g.id}`, 'Эксперт просит передать дело коллеге', g.handover ?? [], (x) => [...caseLine(x),
        `${since(x.requested_at)} · причина: ${x.reason}`, ...handoverWhy(x),
        // Срок по заданию на оценку раньше срока дела (2.327): к нему сдавать и новому эксперту — близко или прошёл — красным.
        ...(x.task_due ? [{ class: x.task_due.hot ? 'overdue' : 'muted', role: 'handover-task-due',
          text: `сдать ${x.task_due.by} — к ${dayRu(x.task_due.day)}${x.task_due.overdue ? ', срок прошёл' : ''} (срок дела позже)` }] : [])], toOrg('handover')),
      // Эксперт не принимает дела до … (2.113), а срок его дела — в эти дни: к делу, там «Передать другому эксперту» уже открыто.
      ...group(`org-away-${g.id}`, 'Эксперт не принимает дела — срок в эти дни', g.away ?? [], (x) => [...caseLine(x),
        // Перенос уже просит — строкой выше; передать некому — не «передайте коллеге» (прогон 2.210).
        `не принимает дела до ${dayRu(x.away_until)}${x.away_note ? ` · ${x.away_note}` : ''}${x.extend ? ''
          : x.can_transfer ? ' · передайте коллеге' : ' · передать некому — попросите перенести срок'}`], toOrg('transfer')),
      ...group(`org-risk-${g.id}`, 'Горит: нет черновика или фото осмотра', g.at_risk ?? [], (x) => [...caseLine(x), x.missing.join(' · ')], toOrg('case')),
      // Ждут подписи организации 2 дня и дольше (2.374) — отдельной строкой выше, в «Ждут подписи организации» не повторяются.
      ...group(`org-sign-long-${g.id}`, 'Ждут подписи организации 2 дня и дольше', g.to_sign.filter((x) => x.long), signLine, toOrg('sign')),
      // Дольше всех ждущие — первыми (порядок с сервера, 2.161); ждущие 2 дня и дольше — строкой выше (2.374).
      ...group(`org-sign-${g.id}`, 'Ждут подписи организации', g.to_sign.filter((x) => !x.long), signLine, toOrg('sign')),
      ...group(`org-pending-${g.id}`, 'Ждут назначения эксперта', g.pending, caseLine, toOrg('pending')),
      ...group(`org-hot-${g.id}`, 'Горит срок у экспертов', g.hot.filter((x) => !risky.has(x.order_ref)), caseLine, toOrg('case')),
      // Когда вернули и сколько пунктов эксперт уже отметил исправленными (2.160 — как в «Делах экспертов»);
      // «Напомнить эксперту» прямо здесь (2.162).
      ...orgReturned(g, caseLine, toOrg('case')),
      // Аттестат или полис эксперта кончается до 15 января (2.406, как у эксперта 2.405): в декабре — «продлите до каникул».
      ...orgDossierNewYear(g, t.today, toOrg()),
      // Досье экспертов (2.63): только вид документа и срок; копии руководитель не видит.
      ...group(`org-dossier-${g.id}`, 'Документы экспертов: срок', g.dossier ?? [], (x) => [`${x.expert} · ${x.kind_name}`,
        x.state === 'expired' ? `срок истёк ${dayRu(x.valid_until)} — по оценке эксперт снят с подбора` : `действует до ${dayRu(x.valid_until)} · осталось ${daysLeft(x.valid_until, t.today)} дн.`], toOrg()),
    ];
    if (part.length) rows.push(el('li', { class: 'group org', text: `Организация: ${g.name}` }), ...part);
  }
  // Эксперт или руководитель без срочного — короткая строка «срочного нет»; заказчику карточка не нужна.
  box.classList.toggle('hidden', !e && !d && !t.orgs.length);
  $('today-list').replaceChildren(...rows);
  $('today-empty').classList.toggle('hidden', rows.length > 0);
}
