// Задача 2.55: журнал действий по делу и выгрузка дела архивом. Данные — демо-площадка (tests/tools/demo-seed.mjs):
// закрытое дело частного заказчика, дело юрфирмы на проверке. Проверяется: служебный видит всё с именами, стороны —
// только своё и без лишних имён, посторонний — «не найдено»; архив — карточка, файлы с подписями, акт, суммы SHA-256;
// исполнителю архив не выдаётся; выгрузка пишется в журнал.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { startApp } from '../helpers.mjs';
import { grantRole } from '../../src/tools/grant-role.mjs';
import { seedDemo, stageLogin, DEMO_PEOPLE } from '../tools/demo-seed.mjs';

const KEY = 'demo-stage-login-key-0123456789abcdef';
const ADMIN = '+79990009500';
let S, R;

// Распаковка ZIP (для проверки архива).
function unzip(buf) {
  const out = new Map();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString('utf8');
    const body = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 30 + nlen + xlen + csize;
  }
  return out;
}
const docText = (docx) => unzip(docx).get('word/document.xml').toString('utf8').replace(/<[^>]+>/g, ' ');

before(async () => {
  S = await startApp({ STAGE_LOGIN_KEY: KEY, AUTH_RATE_MAX: '500' });
  await grantRole(S.sql, ADMIN, 'admin');
  R = await seedDemo({ base: S.base, login: stageLogin(S.base, {}, KEY), adminPhone: ADMIN });
});
after(async () => { await S?.close(); });

// client() хранит cookie в замыкании — ставим её через запрос с заголовком.
function withSession(k) {
  const cookie = R.sessions[k];
  return { req: (m, p, b) => fetch(S.base + p, { method: m, headers: { cookie, ...(m !== 'GET' ? { 'x-delo-request': '1' } : {}) }, redirect: 'manual' }) };
}
const journal = async (k, id) => { const r = await withSession(k).req('GET', `/api/orders/${id}/journal`); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };

test('журнал по делу: служебный — всё с именами; заказчик — своё, без черновиков и имён исполнителя; посторонний — нет', async () => {
  const id = R.cases.flat;
  const d = await journal('dispatcher', id);
  assert.equal(d.status, 200);
  assert.equal(d.body.full, true);
  const whatD = d.body.journal.map((j) => j.what);
  assert.ok(whatD.includes('Создана заявка'));
  assert.ok(whatD.some((w) => w.startsWith('Назначена цена')));
  assert.ok(whatD.some((w) => w.includes('подпись организации')));
  assert.ok(whatD.some((w) => w.startsWith('Проверено') || w.includes('Отметка по правилу проверки')));
  assert.ok(d.body.journal.some((j) => j.who.startsWith(DEMO_PEOPLE.orlov.name)), 'служебный видит имя эксперта');

  const c = await journal('petrov', id);
  assert.equal(c.status, 200);
  assert.equal(c.body.full, false);
  assert.equal(c.body.can_export, true);
  const txt = JSON.stringify(c.body.journal);
  assert.ok(!txt.includes(DEMO_PEOPLE.orlov.name), 'имя эксперта заказчику не показывается');
  assert.ok(!txt.includes(DEMO_PEOPLE.dispatcher.name));
  assert.ok(!txt.includes('Отметка по правилу проверки'), 'внутренняя проверка — не заказчику');
  assert.ok(c.body.journal.some((j) => j.who === 'Вы' && j.what === 'Создана заявка'));
  assert.ok(c.body.journal.some((j) => j.who === 'Исполнитель' && j.what.includes('подпись эксперта')));
  assert.ok(c.body.journal.some((j) => j.who === 'Платформа' && j.what.startsWith('Назначена цена')));

  const e = await journal('orlov', id);
  assert.equal(e.status, 200);
  assert.equal(e.body.can_export, false);
  for (const k of ['sidorova', 'lawyer', 'headB', 'tikhonov']) assert.equal((await journal(k, id)).status, 404, k);
});

test('журнал дела на проверке: заказчик не видит файл результата до выдачи', async () => {
  const c = await journal('lawyer', R.cases.car_court);
  assert.ok(!c.body.journal.some((j) => j.what.includes('Заключение об оценке автомобиля')));
  const d = await journal('dispatcher', R.cases.car_court);
  assert.ok(d.body.journal.some((j) => j.what.includes('Заключение об оценке автомобиля')));
  // Руководитель фирмы-заказчика видит журнал дела своей фирмы, с именами сотрудников фирмы.
  const h = await journal('headLaw', R.cases.car_court);
  assert.equal(h.status, 200);
  assert.ok(h.body.journal.some((j) => j.who === `Заказчик (${DEMO_PEOPLE.lawyer.name})`));
});

test('выгрузка дела архивом: карточка, файлы, подписи, акт, SHA-256; исполнителю и постороннему — нет', async () => {
  const id = R.cases.flat;
  const r = await withSession('petrov').req('GET', `/api/orders/${id}/export`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /Дело № [0-9A-F]{8} \(\d{4}-\d{2}-\d{2}\)\.zip/);
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  const names = [...files.keys()];
  const card = names.find((n) => n.startsWith('Карточка дела'));
  assert.ok(card);
  assert.ok(names.includes('Документы/Выписка ЕГРН.pdf'));
  assert.ok(names.includes('Документы/Отчёт об оценке квартиры.pdf'));
  assert.ok(names.filter((n) => n.startsWith('Документы/Отчёт об оценке квартиры') && n !== 'Документы/Отчёт об оценке квартиры.pdf').length >= 2, 'подписи эксперта и организации');
  assert.ok(names.some((n) => n.startsWith('Закрывающие документы/')), 'акт');
  const text = docText(files.get(card));
  assert.ok(text.includes('Оценка квартиры для нотариуса'));
  assert.ok(text.includes('Журнал действий'));
  assert.ok(text.includes('Нотариус просит отчёт'), 'переписка');
  const sha = crypto.createHash('sha256').update(files.get('Документы/Выписка ЕГРН.pdf')).digest('hex');
  assert.ok(text.includes(sha), 'контрольная сумма файла в карточке');
  assert.ok(!text.includes(DEMO_PEOPLE.dispatcher.name), 'имя диспетчера заказчику не выдаётся');

  // Выгрузка записана в журнал дела.
  assert.ok((await journal('petrov', id)).body.journal.some((j) => j.what === 'Дело выгружено архивом' && j.who === 'Вы'));
  assert.equal((await withSession('orlov').req('GET', `/api/orders/${id}/export`)).status, 403);
  for (const k of ['sidorova', 'headA', 'lawyer']) assert.equal((await withSession(k).req('GET', `/api/orders/${id}/export`)).status, 404, k);

  // Дело на проверке: заказчику архив без результата; диспетчеру — с результатом.
  const lw = unzip(Buffer.from(await (await withSession('lawyer').req('GET', `/api/orders/${R.cases.car_court}/export`)).arrayBuffer()));
  assert.ok(![...lw.keys()].some((n) => n.includes('Заключение об оценке автомобиля')));
  const dp = unzip(Buffer.from(await (await withSession('dispatcher').req('GET', `/api/orders/${R.cases.car_court}/export`)).arrayBuffer()));
  assert.ok([...dp.keys()].some((n) => n.includes('Заключение об оценке автомобиля')));
});
