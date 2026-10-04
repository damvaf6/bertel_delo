// «Что дальше» в деле исполнителя (разбор 03.10.2026, 2.10): страница дела длинная — вверху шаги работы с отметками,
// переход к каждому разделу и одна главная кнопка для следующего шага; внизу экрана — та же кнопка, пока листаете.
// Шаги считаются по тому, что уже загружено на странице (заявка, документы, проверка) — отдельного запроса нет.
// Текст — только через textContent.
import { el } from '/common.js';

const $ = (id) => document.getElementById(id);
let ctx = {}; // { current, docs, review, draft, analogs, step(action) }

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
    items.push({ id: 'inspect', title: 'Осмотр объекта (по желанию)', done: list.some((d) => d.kind === 'inspection'), go: go(visible('inspect-box') ? 'inspect-box' : 'onsite-box'), optional: true });
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
    if (orgNeed) items.push({ id: 'org', title: `Подпись организации «${docs.signature_org}»`, done: results.length > 0 && !unsigned.length && !orgWait.length, go: go('docs'), wait: true });
  }
  const submit = act('review');
  items.push({ id: 'submit', title: 'Сдача на проверку', done: false, go: go('actions') });

  // Главная кнопка — первый незакрытый обязательный шаг (необязательные — только если до них дошли по порядку).
  const firstOpen = items.find((i) => !i.done && !i.optional && i.id !== 'submit');
  let main;
  if (!firstOpen && submit) main = { label: 'Сдать на проверку', run: () => ctx.step(submit) };
  else if (firstOpen?.id === 'fix') main = { label: 'Исправить по замечанию руководителя', run: go('org-returns-box') };
  else if (firstOpen?.id === 'result') main = { label: 'Добавить файл результата', run: () => $('result-file')?.click() };
  else if (firstOpen?.id === 'sign') main = { label: unsigned.length > 1 ? `Подписать все файлы (${unsigned.length})` : 'Подписать файл', run: () => ctx.signAll?.() };
  else if (firstOpen?.id === 'org') main = { label: 'Ждём подпись руководителя', disabled: true };
  const done = items.filter((i) => i.done).length;
  return { lead: `Сделано ${done} из ${items.length - 1} шагов до сдачи. Нажмите на шаг — откроется его раздел.`, items, main };
}

function render() {
  const box = $('next-box');
  const bar = $('next-bar');
  if (!box || !ctx.current) return;
  const me = ctx.current.executor?.is_me;
  const s = me ? steps() : null;
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
