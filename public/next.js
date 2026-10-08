// «Что дальше» в деле исполнителя (разбор 03.10.2026, 2.10): страница дела длинная — вверху шаги работы с отметками,
// переход к каждому разделу и одна главная кнопка для следующего шага; внизу экрана — та же кнопка, пока листаете.
// Шаги считаются по тому, что уже загружено на странице (заявка, документы, проверка) — отдельного запроса нет.
// Текст — только через textContent.
import { el, quoted } from '/common.js';
import { applyFolds, reveal } from '/fold.js';

const $ = (id) => document.getElementById(id);
let ctx = {}; // { current, docs, review, draft, analogs, docreq, money, deadline, handover, notes, inspect, onsite, chat, loaded, step(action) }

export function setNext(part) {
  ctx = part.reset ? { ...part } : { ...ctx, ...part };
  render();
}

// Нижняя кнопка нужна, только когда карточка «Что дальше» ушла с экрана.
let mainInView = true;
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    mainInView = entries.some((e) => e.isIntersecting);
    $('next-bar')?.classList.toggle('away', mainInView);
  }).observe($('next-box'));
}

const visible = (id) => !!$(id) && !$(id).classList.contains('hidden');
// Файлы результата исполнителя: после передачи дела файлы прежнего эксперта в сдачу не идут (own: false, 2.110).
const ownResults = (list) => list.filter((d) => d.kind === 'result' && d.own !== false);
const go = (id) => () => { reveal(id); $(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

function steps() {
  const { current, docs, review } = ctx;
  const { order, actions = [] } = current;
  const act = (to) => actions.find((a) => a.to === to);
  if (order.status === 'awaiting_executor') {
    return { lead: 'Вам предложено дело: посмотрите данные, срок и вознаграждение.', items: [], main: act('in_work') && { label: 'Принять дело', run: () => ctx.step(act('in_work')) } };
  }
  if (order.status === 'review') return { lead: 'Работа сдана — диспетчер проверяет результат. Замечания придут уведомлением.', items: [] };
  if (order.status === 'done') return { lead: 'Результат выдан заказчику. Выплата — в разделе «Деньги».', items: [] };
  if (order.status !== 'in_work') return null;

  const list = docs?.documents ?? [];
  const results = ownResults(list);
  const lastResultAt = results.reduce((m, d) => (d.created_at > m ? d.created_at : m), '');
  const signNeed = !!docs?.signature_required;
  const orgNeed = !!docs?.signature_org;
  const unsigned = results.filter((d) => !d.signatures?.expert);
  const orgWait = orgNeed ? results.filter((d) => d.signatures?.expert && !d.signatures?.org) : [];
  const ai = review?.ai;
  const aiFresh = !!ai && (!lastResultAt || ai.at >= lastResultAt);
  const items = [];
  if (visible('inspect-box') || visible('onsite-box')) {
    items.push({ id: 'inspect', title: order.subject === 'document' ? 'Съёмка документа (по желанию)' : order.subject === 'goods' ? 'Осмотр товара (по желанию)' : order.subject === 'car' ? 'Осмотр автомобиля (по желанию)' : 'Осмотр объекта (по желанию)', done: list.some((d) => d.kind === 'inspection'), go: go(visible('inspect-box') ? 'inspect-box' : 'onsite-box'), optional: true });
  }
  // Документы от заказчика (2.66): выписка ЕГРН, ПТС… — эксперт видит, что запрошено и что уже пришло, не листая дело.
  const dr = ctx.docreq;
  if (dr && visible('docreq-box')) {
    items.push({ id: 'docs', title: dr.total ? `Документы от заказчика (получено ${dr.got} из ${dr.total})` : 'Документы от заказчика (по желанию)', done: dr.total > 0 && dr.got === dr.total, go: go('docreq-box'), optional: true });
  }
  // Подходы к оценке (2.33): от них зависят разделы черновика и нужны ли аналоги. Не обязательны — эксперту со своим
  // готовым отчётом лишнее действие ни к чему, поэтому главная кнопка к ним не ведёт.
  if (ctx.draft?.approaches) items.push({ id: 'approaches', title: 'Подходы к оценке (для черновика и аналогов)', done: !!ctx.draft.approaches.chosen?.length, go: go('draft-approaches'), optional: true });
  const an = ctx.analogs;
  if (an?.needed && visible('analogs-box')) items.push({ id: 'analogs', title: `Аналоги (подтверждено ${an.confirmed} из ${an.min})`, done: an.confirmed >= an.min, go: go('analogs-box'), optional: true });
  // Черновик сделан, когда он есть (файл из черновика называется по виду документа: «Отчёт об оценке», «Заключение…»).
  if (visible('draft-box')) items.push({ id: 'draft', title: 'Черновик заключения от ИИ (по желанию)', done: !!ctx.draft?.exists, go: go('draft-box'), optional: true });
  items.push({ id: 'result', title: 'Файл результата', done: results.length > 0, go: go('result-upload-box') });
  // Руководитель вернул файл с замечанием (2.27) — сначала исправить по замечанию.
  const returnsOpen = (docs?.org_returns ?? []).filter((r) => r.open);
  if (returnsOpen.length) items.push({ id: 'fix', title: 'Исправить по замечанию руководителя', done: false, go: go('org-returns-box') });
  if (visible('review-box')) items.push({ id: 'ai', title: aiFresh || !ai ? 'ИИ-проверка перед сдачей' : 'ИИ-проверка — файлы менялись, проверьте ещё раз', done: aiFresh && results.length > 0, go: go('review-box'), optional: true });
  if (signNeed) {
    items.push({ id: 'sign', title: 'Подпись УКЭП', done: results.length > 0 && !unsigned.length, go: go('docs') });
    if (orgNeed) items.push({ id: 'org', title: `Подпись организации ${quoted(docs.signature_org)}`, done: results.length > 0 && !unsigned.length && !orgWait.length, go: go('docs'), wait: true });
  }
  const submit = act('review');
  items.push({ id: 'submit', title: 'Сдача на проверку', done: false, go: go('actions') });

  // Главная кнопка — первый незакрытый обязательный шаг (необязательные — только если до них дошли по порядку).
  const firstOpen = items.find((i) => !i.done && !i.optional && i.id !== 'submit');
  let main;
  if (!firstOpen && submit) main = { label: 'Сдать на проверку', run: () => ctx.step(submit) };
  else if (firstOpen?.id === 'fix') main = { label: 'Исправить по замечанию руководителя', run: go('org-returns-box') };
  // Черновик уже есть (2.66) — файл результата обычно из него: кнопка ведёт к «Приложить как файл результата».
  else if (firstOpen?.id === 'result' && ctx.draft?.exists) main = { label: 'Приложить черновик как файл результата', run: () => { go('draft-confirm')(); $('draft-confirm')?.focus({ preventScroll: true }); } };
  else if (firstOpen?.id === 'result') main = { label: 'Добавить файл результата', run: () => { reveal('result-upload-box'); $('result-file')?.click(); } };
  else if (firstOpen?.id === 'sign') main = { label: unsigned.length > 1 ? `Подписать все файлы (${unsigned.length})` : 'Подписать файл', run: () => { reveal('docs'); ctx.signAll?.(); } };
  else if (firstOpen?.id === 'org') main = { label: 'Ждём подпись руководителя', disabled: true };
  const done = items.filter((i) => i.done).length;
  return { lead: `Сделано ${done} из ${items.length - 1} шагов до сдачи. Нажмите на шаг — откроется его раздел.`, items, main };
}

// Заказчику (2.41): по статусу — что происходит и что сделать ему; одна главная кнопка там, где ход за ним.
function customerSteps() {
  const { current, docs, money } = ctx;
  const { order, actions = [] } = current;
  const act = (to) => actions.find((a) => a.to === to);
  const deadline = order.deadline ? ` Срок — ${new Date(`${order.deadline}T00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}.` : '';
  if (order.status === 'new') {
    const missing = current.submit_missing ?? [];
    const send = act('matching');
    return {
      lead: missing.length
        ? `Чтобы отправить заявку, заполните: ${missing.join(', ')}. Сохранять можно частями.`
        : 'Всё нужное заполнено — отправьте заявку. Платформа назначит цену и подберёт исполнителя.',
      items: [],
      main: missing.length ? { label: 'Заполнить заявку', run: go('details-form') } : send && { label: 'Отправить заявку', run: () => ctx.step(send) },
    };
  }
  if (order.status === 'matching') {
    if (money?.can_pay) return { lead: 'Цена назначена. После оплаты заявку передадут исполнителю; деньги хранятся у платформы до выдачи Вам результата.', items: [], main: { label: $('pay')?.textContent || 'Оплатить', run: () => $('pay')?.click() } };
    if (money?.paid) return { lead: 'Оплачено. Платформа подбирает исполнителя — придёт уведомление.', items: [] };
    return { lead: 'Платформа назначит цену — придёт уведомление, после этого заявку можно оплатить.', items: [] };
  }
  if (order.status === 'awaiting_executor') return { lead: 'Исполнитель подобран и смотрит заявку. Как только примет — придёт уведомление.', items: [] };
  if (order.status === 'in_work') return { lead: `Исполнитель работает.${deadline} Вопросы и уточнения — в переписке ниже.`, items: [] };
  if (order.status === 'review') return { lead: 'Работа сдана — платформа проверяет результат, потом он появится здесь.', items: [] };
  if (order.status === 'done') {
    const results = (docs?.documents ?? []).filter((d) => d.kind === 'result');
    const close = act('closed');
    const items = [
      { id: 'result', title: results.length ? `Скачать результат (${results.length})` : 'Результат', done: false, go: go('docs') },
      ...(money?.documents?.length ? [{ id: 'act', title: 'Акт об оказании услуг', done: false, go: go('closing') }] : []),
    ];
    return { lead: 'Результат готов. Скачайте его и проверьте; если всё в порядке — примите работу.', items, main: close && { label: 'Принять и закрыть', run: () => ctx.step(close) } };
  }
  if (order.status === 'closed') return { lead: 'Заявка закрыта. Результат и закрывающие документы остаются здесь — их можно скачать в любое время.', items: [] };
  return null;
}

// Диспетчеру (2.42): цена → оплата заказчика → предложить дело → ответ исполнителя → работа → проверка → выдача.
function dispatcherSteps() {
  const { current, money, review } = ctx;
  const { order, actions = [] } = current;
  const act = (to) => actions.find((a) => a.to === to);
  if (order.status === 'new') return { lead: 'Заказчик ещё заполняет заявку.', items: [] };
  if (order.status === 'matching') {
    if (money?.can_set_price && !money.price_kop) {
      return { lead: 'Назначьте цену — после неё заказчик оплатит заявку.', items: [], main: { label: 'Назначить цену', run: () => { go('money-box')(); $('price')?.focus({ preventScroll: true }); } } };
    }
    if (!money?.paid) return { lead: 'Цена назначена — ждём оплаты заказчика. Пока не оплачено, цену можно изменить.', items: [] };
    return { lead: 'Оплачено. Выберите исполнителя или организацию и предложите дело.', items: [], main: { label: 'К подбору исполнителя', run: go('match-box') } };
  }
  if (order.status === 'awaiting_executor') return { lead: current.offer_org ? `Дело у организации ${quoted(current.offer_org.name)}: эксперта назначает её руководитель.` : 'Дело предложено — ждём ответа исполнителя. Если молчит, верните в подбор с причиной.', items: [] };
  if (order.status === 'in_work') return { lead: 'Исполнитель работает. Если не справляется — «Передать другому исполнителю» с причиной; оплата заказчика остаётся в силе.', items: [] };
  if (order.status === 'review') {
    const s = review?.summary;
    const left = s ? s.unchecked : null;
    const done = act('done');
    if (left) return { lead: `Проверьте результат: отметьте каждое правило (осталось ${left} из ${s.total}). ИИ-проверка подскажет, где смотреть.`, items: [], main: { label: 'К проверке результата', run: go('review-box') } };
    if (s?.issues) return { lead: `Замечаний: ${s.issues}. Верните на доработку — причина уже собрана из замечаний.`, items: [], main: { label: 'К возврату на доработку', run: go('actions') } };
    return { lead: 'Все правила в порядке — выдайте результат заказчику. Выплата исполнителю уйдёт сама.', items: [], main: done && { label: 'Проверено, готово', run: () => ctx.step(done) } };
  }
  if (order.status === 'done') return { lead: 'Результат выдан, выплата исполнителю — автоматически. Заявку закрывает заказчик (или Вы).', items: [] };
  return null;
}

function render() {
  const box = $('next-box');
  const bar = $('next-bar');
  if (!box || !ctx.current) return;
  const me = ctx.current.executor?.is_me;
  const s = me ? steps() : ctx.current.customer ? customerSteps() : ctx.current.dispatcher ? dispatcherSteps() : null;
  renderReady();
  const enabled = !!me && FOLD_STATUSES.includes(ctx.current.order.status);
  applyFolds({ enabled, order: ctx.current.order.id, now: enabled && ctx.loaded ? nowBox(s) : null, notes: enabled ? foldNotes() : {} });
  box.classList.toggle('hidden', !s);
  bar.classList.toggle('hidden', !s?.main);
  if (!s) return;
  $('next-lead').textContent = s.lead;
  $('next-steps').replaceChildren(...s.items.map((i) => el('li', { class: i.done ? 'done' : '', 'data-step': i.id },
    el('button', { class: 'link', onclick: i.go }, `${i.done ? '✓' : '○'} ${i.title}`))));
  // Имя кнопки для чтения с экрана — «Следующий шаг: …» без повторения имени кнопки из «Хода заявки».
  const mk = () => el('button', { class: 'wide', 'data-next': 'main', 'aria-label': 'Следующий шаг', title: s.main.label, ...(s.main.disabled ? { disabled: '' } : {}), onclick: s.main.run }, s.main.label);
  $('next-main').replaceChildren(...(s.main ? [mk()] : []));
  $('next-bar').replaceChildren(...(s.main ? [mk()] : []));
}

// ——— «Готово к сдаче?» (2.106) ———
// Над кнопкой «Сдать на проверку» у исполнителя: файл, подписи, ИИ-проверка, замечания руководителя и диспетчера,
// документы от заказчика, срок — у каждой строки состояние и переход к разделу. «Нет» — без этого сдать нельзя (то же
// проверяет сервер); «стоит посмотреть» — сдать можно. Считается по уже загруженному на странице, отдельного запроса нет.

const DAY = 86_400_000;
const daysLeft = (iso) => {
  const t = new Date();
  return Math.round((new Date(`${iso}T00:00`) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / DAY);
};

export function readyRows() {
  const { current, docs, review, deadline } = ctx;
  const order = current.order;
  const list = docs?.documents ?? [];
  const results = ownResults(list);
  const lastResultAt = results.reduce((m, d) => (d.created_at > m ? d.created_at : m), '');
  const rows = [];
  const row = (id, state, title, note, to) => rows.push({ id, state, title, note, to });
  row('result', results.length ? 'ok' : 'no', 'Файл результата',
    results.length ? results.map((d) => d.filename).join(', ')
      : list.some((d) => d.kind === 'result') ? 'файлы прежнего эксперта в сдачу не идут — загрузите свой'
        : 'не приложен, без него сдать нельзя',
    ctx.draft?.exists && visible('draft-box') ? 'draft-box' : 'docs-box');
  if (docs?.signature_required) {
    const unsigned = results.filter((d) => !d.signatures?.expert).length;
    row('sign', results.length && !unsigned ? 'ok' : 'no', 'Подпись УКЭП',
      !results.length ? 'подписывается файл результата' : unsigned ? `не подписано файлов: ${unsigned}` : 'все файлы результата подписаны', 'docs-box');
    if (docs.signature_org) {
      const wait = results.filter((d) => !d.signatures?.org).length;
      row('org', results.length && !wait ? 'ok' : 'no', `Подпись организации ${quoted(docs.signature_org)}`,
        !results.length || unsigned ? 'после Вашей подписи' : wait ? 'ждём подпись руководителя' : 'подписано', 'docs-box');
    }
  }
  const returns = (docs?.org_returns ?? []).filter((r) => r.open);
  if (returns.length) {
    const left = returns.reduce((n, r) => n + (r.items?.length ? r.left : 1), 0);
    row('fix', 'warn', 'Замечания руководителя', left ? `не отмечено исправленными: ${left}` : 'все пункты отмечены, подпишите файл заново', 'org-returns-box');
  }
  if (review?.round > 0 && order.status === 'in_work') {
    const issues = (review.checks ?? []).filter((c) => c.verdict === 'issue');
    if (issues.length) row('remarks', 'warn', `Замечания диспетчера (круг ${review.round})`, `проверьте, что исправлено: ${issues.map((c) => c.title).join('; ')}`, 'review-box');
  }
  if (visible('review-box') && (review?.can_ai || review?.ai)) {
    const ai = review.ai;
    const titles = new Map((review.checks ?? []).map((c) => [c.id, c.title]));
    const look = (ai?.items ?? []).filter((i) => i.hint === 'attention');
    if (!ai) row('ai', 'warn', 'ИИ-проверка', 'не запускалась, проверьте результат перед сдачей', 'review-box');
    else if (lastResultAt && ai.at < lastResultAt) row('ai', 'warn', 'ИИ-проверка', 'файлы менялись после проверки, проверьте ещё раз', 'review-box');
    else if (look.length) row('ai', 'warn', 'ИИ-проверка', `стоит посмотреть: ${look.map((i) => titles.get(i.id) || i.id).join('; ')}`, 'review-box');
    else row('ai', 'ok', 'ИИ-проверка', 'замечаний ИИ не видит', 'review-box');
  }
  const dr = ctx.docreq;
  if (dr?.total && visible('docreq-box')) {
    row('docs', dr.got === dr.total ? 'ok' : 'warn', 'Документы от заказчика',
      dr.got === dr.total ? `получены все: ${dr.total}` : `получено ${dr.got} из ${dr.total}`, 'docreq-box');
  }
  if (deadline?.deadline) {
    const d = daysLeft(deadline.deadline);
    const when = d < 0 ? `срок прошёл ${dayRu(deadline.deadline)}` : d === 0 ? 'срок сегодня' : d === 1 ? 'срок завтра' : `до ${dayRu(deadline.deadline)}`;
    row('deadline', d < 0 || deadline.open ? 'warn' : 'ok', 'Срок',
      deadline.open ? `${when} · просьба о переносе ждёт ответа` : when, 'deadline-box');
  }
  return rows;
}

const MARK = { ok: '✓', warn: '!', no: '✕' };
const STATE_RU = { ok: 'готово', warn: 'стоит посмотреть', no: 'нет' };

function renderReady() {
  const box = $('ready-box');
  if (!box) return;
  const on = !!ctx.current?.executor?.is_me && ctx.current.order.status === 'in_work' && !!ctx.docs;
  box.classList.toggle('hidden', !on);
  if (!on) return box.querySelector('ul').replaceChildren();
  const rows = readyRows();
  const no = rows.filter((r) => r.state === 'no').length;
  const warn = rows.filter((r) => r.state === 'warn').length;
  $('ready-lead').textContent = no
    ? `Пока сдать нельзя: не готово ${count(no, 'пункт', 'пункта', 'пунктов')}. Нажмите на строку — откроется нужный раздел.`
    : warn
      ? `Сдать можно. Стоит посмотреть: ${count(warn, 'пункт', 'пункта', 'пунктов')} — нажмите на строку, чтобы перейти.`
      : 'Всё готово — можно сдавать на проверку.';
  box.dataset.state = no ? 'no' : warn ? 'warn' : 'ok';
  box.querySelector('ul').replaceChildren(...rows.map((r) => el('li', { class: `ready ${r.state}`, 'data-ready': r.id },
    el('button', { type: 'button', class: 'link', 'aria-label': `${r.title}: ${STATE_RU[r.state]}. ${r.note}`, onclick: () => { reveal(r.to); $(r.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      el('span', { class: 'ready-mark', 'aria-hidden': 'true', text: MARK[r.state] }),
      el('span', {}, el('span', { class: 'title', text: r.title }), el('span', { class: 'muted', text: ` — ${r.note}` }))))));
}

// ——— Свёрнутые блоки дела у исполнителя (2.101) ———

const FOLD_STATUSES = ['in_work', 'review', 'done', 'closed'];
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

// Нужен сейчас — блок первого несделанного шага (необязательные — по порядку, как в «Что дальше»); запрошенные документы —
// только если что-то запрошено и ещё не пришло. Сдано на проверку — раскрывать нечего.
function nowBox(s) {
  if (ctx.current.order.status !== 'in_work' || !s?.items) return null;
  const open = s.items.find((i) => !i.done && !(i.id === 'docs' && !ctx.docreq?.total));
  const box = {
    inspect: visible('inspect-box') ? 'inspect-box' : 'onsite-box',
    docs: 'docreq-box',
    approaches: 'draft-box',
    analogs: 'analogs-box',
    draft: 'draft-box',
    result: ctx.draft?.exists && visible('draft-box') ? 'draft-box' : 'docs-box',
    ai: 'review-box',
    sign: 'docs-box',
    org: 'docs-box',
  }[open?.id];
  return box ?? null;
}

const count = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

function foldNotes() {
  const { docs, review, draft, analogs, docreqAll, deadline, handover, inspect, onsite, chat, notes: myNotes, similar } = ctx;
  const notes = {};
  if (myNotes) notes['notes-box'] = myNotes;
  if (deadline) notes['deadline-box'] = `до ${dayRu(deadline.deadline)}${deadline.open ? ' · просьба о переносе ждёт ответа' : ''}`;
  if (handover) notes['handover-box'] = handover;
  if (docreqAll) notes['docreq-box'] = docreqAll.total ? `получено ${docreqAll.got} из ${docreqAll.total}` : 'ничего не запрошено';
  if (docs) {
    const list = docs.documents ?? [];
    const results = ownResults(list);
    const unsigned = results.filter((d) => !d.signatures?.expert).length;
    const orgWait = docs.signature_org ? results.filter((d) => d.signatures?.expert && !d.signatures?.org).length : 0;
    notes['docs-box'] = [
      list.length ? `файлов: ${list.length}` : 'файлов нет',
      results.length ? `результат: ${results.length}` : 'результата нет',
      docs.signature_required && results.length ? (unsigned ? `не подписано: ${unsigned}` : orgWait ? 'ждёт подписи организации' : 'подписано') : null,
    ].filter(Boolean).join(' · ');
  }
  if (inspect) notes['inspect-box'] = inspect.photos ? `фото: ${inspect.photos}${inspect.missing ? ` · не снято: ${count(inspect.missing, 'шаг', 'шага', 'шагов')}` : ''}` : inspect.issued ? 'ссылка выдана, фото пока нет' : 'фото нет';
  if (onsite) notes['onsite-box'] = onsite;
  if (analogs) notes['analogs-box'] = analogs.needed ? `подтверждено ${analogs.confirmed} из ${analogs.min}` : `подтверждено: ${analogs.confirmed}`;
  if (similar) notes['similar-box'] = similar;
  if (draft) notes['draft-box'] = draft.exists ? 'черновик есть' : 'черновика нет';
  if (review) {
    const results = ownResults(docs?.documents ?? []);
    const last = results.reduce((m, d) => (d.created_at > m ? d.created_at : m), '');
    const ai = review.ai;
    const aiNote = !ai ? 'ИИ-проверка не запускалась' : !last || ai.at >= last ? 'ИИ-проверка сделана' : 'файлы менялись — проверьте ИИ ещё раз';
    const s = review.summary;
    notes['review-box'] = review.round > 0 && s ? `круг ${review.round}: в порядке ${s.ok} из ${s.total}${s.issues ? `, замечаний: ${s.issues}` : ''}` : aiNote;
  }
  if (chat) notes['chat-box'] = chat.count ? `сообщений: ${chat.count}` : 'сообщений нет';
  return notes;
}
