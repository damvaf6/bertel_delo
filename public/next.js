// «Что дальше» в деле исполнителя (разбор 03.10.2026, 2.10): страница дела длинная — вверху шаги работы с отметками,
// переход к каждому разделу и одна главная кнопка для следующего шага; внизу экрана — та же кнопка, пока листаете.
// Шаги считаются по тому, что уже загружено на странице (заявка, документы, проверка) — отдельного запроса нет.
// Текст — только через textContent.
import { el, quoted } from '/common.js';

const $ = (id) => document.getElementById(id);
let ctx = {}; // { current, docs, review, draft, analogs, docreq, money, step(action) }

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
const go = (id) => () => { $(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

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
  const results = list.filter((d) => d.kind === 'result');
  const lastResultAt = results.reduce((m, d) => (d.created_at > m ? d.created_at : m), '');
  const signNeed = !!docs?.signature_required;
  const orgNeed = !!docs?.signature_org;
  const unsigned = results.filter((d) => !d.signatures?.expert);
  const orgWait = orgNeed ? results.filter((d) => d.signatures?.expert && !d.signatures?.org) : [];
  const ai = review?.ai;
  const aiFresh = !!ai && (!lastResultAt || ai.at >= lastResultAt);
  const items = [];
  if (visible('inspect-box') || visible('onsite-box')) {
    items.push({ id: 'inspect', title: order.subject === 'document' ? 'Съёмка документа (по желанию)' : order.subject === 'goods' ? 'Осмотр товара (по желанию)' : 'Осмотр объекта (по желанию)', done: list.some((d) => d.kind === 'inspection'), go: go(visible('inspect-box') ? 'inspect-box' : 'onsite-box'), optional: true });
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
  else if (firstOpen?.id === 'result') main = { label: 'Добавить файл результата', run: () => $('result-file')?.click() };
  else if (firstOpen?.id === 'sign') main = { label: unsigned.length > 1 ? `Подписать все файлы (${unsigned.length})` : 'Подписать файл', run: () => ctx.signAll?.() };
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
