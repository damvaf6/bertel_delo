// Экскурсия по демо-площадке на 10 минут (задача 2.51): что показывать ЦНЭР и юрфирмам, в каком порядке и что говорить.
// Один и тот же сценарий — в документе docs/demo-ekskursiya.md (для показа) и в проверке на телефоне 412×915 (снимки
// каждого шага + PDF «Демо-экскурсия», tests/tools/tour-pdf.mjs). Данные — из tests/tools/demo-seed.mjs.
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { DEMO_PEOPLE } from './demo-seed.mjs';

// Шаги: минута показа, кто вошёл, что открыть (open — адрес или функция), что снять (what), что сказать (say).
// case — ключ дела из DEMO_CASES; org — ключ организации.
export const DEMO_TOUR = [
  { min: '0:00', who: 'lawyer', title: 'Юрист фирмы: все заявки фирмы', open: '/kabinet', wait: '#orders li',
    say: 'Юрист заказывает экспертизы от имени фирмы. Все заявки — одним списком с состоянием: на проверке, в работе, ждёт исполнителя.' },
  { min: '1:00', who: 'lawyer', title: 'Юрист: дело на проверке', open: { case: 'car_court' }, wait: '#order-status',
    say: 'По каждому делу видно, что сейчас происходит и что дальше; срок и документы суда — в деле. Эксперт уже сдал отчёт, платформа его проверяет.' },
  { min: '2:00', who: 'petrov', title: 'Заказчик: результат готов', open: { case: 'goods' }, wait: '#docs li', what: ['#docs', '#money-box'],
    say: 'Заказчик скачивает заключение с электронной подписью эксперта и организации, сам проверяет подпись; акт — файлом. Остаётся «Принять и закрыть».' },
  { min: '3:00', who: 'dispatcher', title: 'Диспетчер: все дела платформы', open: '/kabinet', wait: '#orders li',
    say: 'Диспетчер видит все дела и отбирает их по состоянию. Ничего не теряется: у каждого дела — срок и ответственный.' },
  { min: '3:40', who: 'dispatcher', title: 'Диспетчер: подбор исполнителя', open: { case: 'equipment' }, wait: '#candidates li', what: '#match-box',
    say: 'Дело оплачено — платформа сама предлагает экспертов и организации с допуском, по району, загрузке и качеству. Диспетчер выбирает.' },
  { min: '4:30', who: 'dispatcher', title: 'Диспетчер: проверка результата', open: { case: 'car_court' }, wait: '#review-checks li', what: '#review-box',
    say: 'Перед выдачей отчёт проверяется по правилам: реквизиты, объект, расчёт, аналоги, сведения об оценщике. ИИ подсказывает места, решает человек.' },
  { min: '5:20', who: 'morozova', title: 'Эксперт: мои дела и «Сегодня»', open: '/kabinet', wait: '#orders li',
    say: 'Эксперт видит свои дела и что горит сегодня. Дела приходят предложением — эксперт принимает или отказывается.' },
  { min: '6:00', who: 'morozova', title: 'Эксперт: дело в работе', open: { case: 'land' }, wait: '#messages li', what: '#chat-box',
    say: 'В деле — документы заказчика, осмотр по ссылке, аналоги, черновик отчёта от ИИ и переписка. Имя эксперта заказчику не показывается.' },
  { min: '6:50', who: 'tikhonov', title: 'Эксперт: предложенное дело', open: { case: 'crash' }, wait: '#order-status',
    say: 'Предложение дела: данные, срок и вознаграждение эксперта (80% цены) — до того, как он согласится.' },
  { min: '7:30', who: 'tikhonov', title: 'Эксперт: досье и сроки документов', open: '/kabinet#specialist', wait: '#dossier-items li', what: '#dossier-box',
    say: 'Досье: аттестат, СРО, полисы. Платформа напоминает о сроках заранее, а сведения сама подставляет в отчёт.' },
  { min: '8:10', who: 'headA', title: 'Руководитель: дела экспертов организации', open: { org: 'A' }, wait: '#org-title', what: '#org-cases-box',
    say: 'Руководитель организации видит, какие дела у его экспертов, нагрузку и сроки; дело, предложенное организации, назначает эксперту сам.' },
  { min: '8:50', who: 'headA', title: 'Руководитель: сотрудники и шаблон отчёта', open: { org: 'A' }, wait: '#org-title', what: ['#org-template-box', '#members'],
    say: 'Сотрудники с ролями и числом дел; свой шаблон отчёта Word — черновики экспертов собираются в нём.' },
  { min: '9:30', who: 'dispatcher', title: 'Деньги', open: '/kabinet#money', wait: '#money-payments li',
    say: 'Заказчик платит при заказе; эксперту — 80% после выдачи результата, платформе — 20%. Счёт, акт и отчёт агента — файлами Word.' },
];

// Снимает экскурсию: sessions — cookie демо-людей (из seedDemo), headers — заголовки площадки (IAM-токен на stage).
// out — папка с tour.json и screens/ для PDF.
export async function demoTour({ browser, baseURL, headers = {}, sessions, cases, orgs, out = 'test-results/demo', base = 'stage' }) {
  fs.mkdirSync(`${out}/screens`, { recursive: true });
  const origin = new URL(baseURL).origin;
  const pages = {};
  const pageOf = async (who) => {
    if (pages[who]) return pages[who];
    const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    if (Object.keys(headers).length) await ctx.route((u) => u.origin === origin, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), ...headers } }));
    const [name, ...rest] = sessions[who].split('=');
    await ctx.addCookies([{ name, value: rest.join('='), url: origin }]);
    pages[who] = await ctx.newPage();
    return pages[who];
  };
  const shots = [];
  for (const [i, s] of DEMO_TOUR.entries()) {
    const page = await pageOf(s.who);
    const url = typeof s.open === 'string' ? s.open : s.open.case ? `/kabinet#order=${cases[s.open.case]}` : `/kabinet#org=${orgs[s.open.org]}`;
    await page.goto(url);
    await page.reload();
    await expect(page.locator(s.wait).first()).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${s.title}: страница шире экрана`).toBeLessThanOrEqual(412);
    const file = `demo-${String(i + 1).padStart(2, '0')}.png`;
    const path = `${out}/screens/${file}`;
    await page.waitForTimeout(300);
    if (!s.what) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path });
    } else {
      const list = (Array.isArray(s.what) ? s.what : [s.what]).map((w) => page.locator(w).first());
      await list[0].scrollIntoViewIfNeeded();
      const boxes = [];
      for (const l of list) boxes.push(await l.boundingBox());
      const sy = await page.evaluate(() => window.scrollY);
      const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 8);
      const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8;
      await page.screenshot({ path, fullPage: true, clip: { x: 0, y: top + sy, width: 412, height: Math.min(bottom - top, 4000) } });
    }
    const p = DEMO_PEOPLE[s.who];
    shots.push({ file, cabinet: `${s.min} · ${p.name}`, title: s.title, caption: s.say });
  }
  fs.writeFileSync(`${out}/tour.json`, JSON.stringify({
    at: new Date().toISOString(), base, shots,
    title: 'БЕРТЕЛ Дело — демо-экскурсия на 10 минут',
    note: 'Демо-площадка: все люди, организации, объекты и отчёты вымышленные, номера +7 999 000-1x-xx. Оплата и подпись — тестовые.',
    order: 'Порядок показа: юрист фирмы → частный заказчик → диспетчер → эксперт → руководитель экспертной организации → деньги. Сценарий и что говорить — docs/demo-ekskursiya.md.',
  }, null, 2));
  for (const p of Object.values(pages)) await p.context().close();
  return shots;
}
