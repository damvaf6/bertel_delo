// «Сегодня» (2.34): над списком дел — что требует внимания сейчас. Эксперту: горит по срокам, вернули на доработку, новые
// предложения, ждут проверки диспетчера. Руководителю экспертной организации — по делам его экспертов: горит срок, ждут
// подписи организации, вернул эксперту, ждут назначения (без данных заказчика), сроки документов досье экспертов (2.63),
// «горящие» — срок через 1–2 дня, а нет черновика или фото осмотра (2.98). Эксперту — очередь подписи организации (2.99).
// Эксперт не принимает дела, а срок его дела в эти дни (2.113) — передать коллеге.
// Напоминания по своим заметкам к делу (2.115). Заказчик ждёт ответа в переписке больше суток (2.132). Срок близко, а файла
// результата нет (2.138). «Вернули на доработку» — когда вернули и сколько осталось до срока (2.147).
// Руководитель не подписал 2 дня и дольше (2.152) — отдельной строкой с «Напомнить руководителю» прямо здесь.
// Ответ диспетчера на просьбу о переносе срока — до первого просмотра «Срока» в деле (2.155).
// «Можно продолжать» (2.86) — пришли документы, осмотр или сообщение. Диспетчеру (2.42) — деньги, проверка, цена, подбор, молчащие исполнители, горящие сроки. Нажатие — в дело или в раздел
// организации.
// Тексты — только через textContent.
import { api, el } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const since = (iso) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
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
  return `${n === 0 ? 'срок сегодня' : n === 1 ? 'срок завтра' : `срок ${dayRu(x.deadline)} · осталось ${n} дн.`}${ext}`;
}

// Группа строк: заголовок с числом и строки-кнопки.
function group(id, title, items, line, go) {
  if (!items.length) return [];
  return [el('li', { class: 'group', 'data-today': id, text: `${title} · ${items.length}` }),
    ...items.map((x) => el('li', { 'data-today-item': id },
      el('button', { class: 'open', onclick: () => go(x) }, ...line(x).map((t, i) => el('div', { class: i ? 'muted' : 'title', text: t })))))];
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
    rows.push(
      ...group('no-result', 'Срок близко — нет файла результата', noResult, (x) => [x.title, `${x.service} · ${deadline({ ...x, who: 'Вы попросили' }, t.today)}`,
        // Перенос уже попросили (2.140) — второй раз не предлагаем.
        x.has_draft ? 'черновик есть — соберите отчёт Word и загрузите файл'
          : x.extend ? 'загрузите файл результата' : 'загрузите файл результата или попросите перенести срок'],
      (x) => { location.hash = `order=${x.id}&to=result`; }),
      // Диспетчер ответил на просьбу о переносе срока (2.155) — пока эксперт не открыл «Срок» в деле.
      ...group('extend-answer', 'Ответ на просьбу о переносе срока', e.extend_answer ?? [], (x) => [x.title,
        x.outcome === 'approved' ? `Диспетчер согласился: срок перенесён на ${dayRu(x.new_deadline)} (был ${dayRu(x.old_deadline)})`
          : `Диспетчер отказал в переносе на ${dayRu(x.new_deadline)} — срок прежний, ${dayRu(x.old_deadline)}`,
        x.answer ? `пояснение: ${x.answer}` : `ответил ${since(x.decided_at)}`],
      (x) => { location.hash = `order=${x.id}&to=deadline`; }),
      ...signLate((e.sign_wait ?? []).filter((x) => x.long)),
      // Можно продолжать (2.86): пришло новое после того, как эксперт открывал дело, — сразу к переписке, документам или осмотру.
      ...group('ready', 'Можно продолжать', e.ready ?? [], (x) => [x.title, `${x.what.join(' · ')} · ${since(x.at)}`, deadline(x, t.today)],
        (x) => { location.hash = `order=${x.id}&to=${x.to}`; }),
      // Заказчик ждёт ответа больше суток (2.132) — сразу к переписке в деле.
      ...group('reply-wait', 'Заказчик ждёт ответа', e.reply_wait ?? [], (x) => [x.title,
        `«${x.last}»${x.count > 1 ? ` · сообщений без ответа: ${x.count}` : ''}`,
        `написал ${since(x.since)} — ждёт ${waited(x.since)}`],
      (x) => { location.hash = `order=${x.id}&to=chat`; }),
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
        deadline(x, t.today)].filter(Boolean),
      (x) => { location.hash = x.to ? `order=${x.id}&to=${x.to}` : `order=${x.id}`; }),
      // Осмотр по ссылке 2 дня без фото (2.85) — сразу к осмотру в деле, там «Отправить ссылку снова».
      ...group('inspect-silent', 'Осмотр: 2 дня нет фото', e.inspect_silent ?? [], (x) => [x.title,
        `ссылка от ${since(x.link_at)}${x.expired ? ' — срок истёк' : ''}${x.sms_to ? ` · СМС на ${x.sms_to}` : ''} · отправьте снова`],
      (x) => { location.hash = `order=${x.id}&to=inspect`; }),
      ...group('hot', 'Горит срок', e.hot.filter((x) => !noResult.some((n) => n.id === x.id)), (x) => [x.title, `${x.service} · ${deadline({ ...x, who: 'Вы попросили' }, t.today)}`], toOrder),
      ...group('offers', 'Новые предложения', e.offers, (x) => [x.title, [x.service, x.fee_kop ? `Вам ${rub(x.fee_kop)}` : null, deadline(x, t.today)].filter(Boolean).join(' · ')], toOrder),
      ...group('review', 'Ждут проверки диспетчера', e.review, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
    );
  }
  const d = t.dispatcher;
  if (d) {
    const MONEY = { payout: 'Выплата исполнителю не прошла', refund: 'Возврат заказчику не прошёл', payment: 'Оплата висит больше суток' };
    rows.push(
      ...group('d-money', 'Деньги', d.money, (x) => [x.title, [MONEY[x.what], x.failure].filter(Boolean).join(': ')], toOrder),
      // Перенос срока (2.91) — сразу к блоку «Срок» в деле: согласиться или отказать.
      ...group('d-extend', 'Просят перенести срок', d.extend ?? [], (x) => [x.title, `${deadline(x, t.today)} → просят ${dayRu(x.new_deadline)}`, `причина: ${x.reason}`],
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
    const toOrg = (to) => (x) => {
      location.hash = x?.order_ref ? `org=${g.id}&case=${x.order_ref.slice(2)}&to=${to}` : `org=${g.id}`;
    };
    const caseLine = (x) => [`${x.service} · ${x.order_ref}`, [x.expert, deadline({ ...x, who: 'эксперт просит' }, t.today)].filter(Boolean).join(' · ')];
    // «Горящие» (2.98) — сразу после просьб передать дело; в «Горит срок у экспертов» они не повторяются.
    const risky = new Set((g.at_risk ?? []).map((x) => x.order_ref));
    const part = [
      // Эксперт просит передать дело коллеге (2.107) — к делу в «Делах экспертов»: «Передать» или «Отказать».
      ...group(`org-handover-${g.id}`, 'Эксперт просит передать дело коллеге', g.handover ?? [], (x) => [...caseLine(x),
        `${since(x.requested_at)} · причина: ${x.reason}`], toOrg('handover')),
      // Эксперт не принимает дела до … (2.113), а срок его дела — в эти дни: к делу, там «Передать другому эксперту» уже открыто.
      ...group(`org-away-${g.id}`, 'Эксперт не принимает дела — срок в эти дни', g.away ?? [], (x) => [...caseLine(x),
        `не принимает дела до ${dayRu(x.away_until)}${x.away_note ? ` · ${x.away_note}` : ''} · передайте коллеге`], toOrg('transfer')),
      ...group(`org-risk-${g.id}`, 'Горит: нет черновика или фото осмотра', g.at_risk ?? [], (x) => [...caseLine(x), x.missing.join(' · ')], toOrg('case')),
      ...group(`org-sign-${g.id}`, 'Ждут подписи организации', g.to_sign, (x) => [...caseLine(x),
        `файлов: ${x.files}${x.reminded_at ? ` · эксперт напомнил ${since(x.reminded_at)}` : ''}`], toOrg('sign')),
      ...group(`org-pending-${g.id}`, 'Ждут назначения эксперта', g.pending, caseLine, toOrg('pending')),
      ...group(`org-hot-${g.id}`, 'Горит срок у экспертов', g.hot.filter((x) => !risky.has(x.order_ref)), caseLine, toOrg('case')),
      ...group(`org-returned-${g.id}`, 'Вернули эксперту — ждём исправления', g.returned, (x) => [...caseLine(x), `замечание: ${x.comment}`], toOrg('case')),
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
