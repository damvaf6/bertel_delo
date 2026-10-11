// Перебор номеров в адресе (задача штаба 3f617197-…8166, до репетиции CRM 17.10): под каждой ролью подставляем в адрес
// КАЖДОЙ закрытой операции с номером номера чужих заявок, документов, карточек, организаций и вложенных записей
// (аналог, заметка, запрос документов, просьба о переносе, ссылка на осмотр, выезд, заготовка, досье…), в двух видах:
// всё чужое и «своё дело + чужая вложенная запись». Ответ — только «нет доступа» или «не найдено», в ответе нет чужого,
// у чужих ничего не меняется. Новая операция с номером в адресе попадает в перебор сама. И: ключей и паролей нет
// ни в файлах страниц, ни в том, что сервер отдаёт браузеру.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, login, client, makeOrg, addMember, setPlatformRole, ensurePaid, makeSpecialist, BRIDGE_SECRET, TEST_TOKEN } from '../helpers.mjs';
import { listOps } from '../../src/app.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, dispatcher;
const W = {}; // два одинаковых «мира»: А (кто подбирает номера) и Б (чьи номера)
const MARK = 'Чужое-Б-7731'; // метка в текстах мира Б — не должна появиться ни в одном ответе людям из мира А

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '400' });
  // Диспетчер предлагает дела организациям; сам в переборе не участвует — служебным видно всё (policy.mjs).
  dispatcher = await login(S, '+79990007900');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  W.A = await world('А', '+7999000770', 'Своё-А');
  W.B = await world('Б', '+7999000780', MARK);
});
after(async () => { await S?.close(); });

// Мир: заказчик с личной заявкой и документом; организация (руководитель и эксперт); дело организации в работе у
// эксперта со всем вложенным; частный специалист; разбор проблемы ИИ; выезд помощника; приглашение в организацию.
async function world(tag, prefix, mark) {
  const u = {};
  for (const [k, n] of Object.entries({ client: 1, head: 2, expert: 3, spec: 4, helper: 5, invitee: 6 })) u[k] = await login(S, `${prefix}${n}`);
  const org = await makeOrg(S.sql, `Тестовая организация ${tag} ${mark}`);
  await addMember(S.sql, org.id, u.head.user.id, 'head');
  await addMember(S.sql, org.id, u.expert.user.id, 'member');
  for (const k of ['expert', 'spec']) await makeSpecialist(S.sql, u[k].user.id);
  await S.sql`insert into specialists (user_id, regions, onsite) values (${u.helper.user.id}, ${['moscow']}, true)`;
  await S.sql`update users set full_name = ${`Эксперт ${tag} ${mark}`} where id = ${u.expert.user.id}`;
  assert.equal((await u.expert.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: `г. Москва, ${mark} ул., 1` };
  const make = async (title, express = false) => {
    const o = (await u.client.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await u.client.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: addDays(todayMsk(), 12), express })).status, 200);
    return o;
  };
  const personal = await make(`Личная заявка ${mark}`);
  const doc = await file(u.client, `/api/orders/${personal.id}/documents`, `${mark}.txt`);
  const kase = await make(`Дело организации ${mark}`, true); // экспресс — с выездом помощника
  assert.equal((await u.client.req('POST', `/api/orders/${kase.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, kase.id);
  const ok = async (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body; };
  await ok(await dispatcher.req('POST', `/api/orders/${kase.id}/offer`, { org_id: org.id, from: 'matching' }));
  await ok(await u.head.req('POST', `/api/orgs/${org.id}/cases/${kase.id}/assign`, { specialist_id: u.expert.user.id }));
  await ok(await u.expert.req('POST', `/api/orders/${kase.id}/status`, { from: 'awaiting_executor', to: 'in_work' }));
  const caseDoc = await file(u.client, `/api/orders/${kase.id}/documents`, `${mark}-выписка.txt`);
  const result = await file(u.expert, `/api/orders/${kase.id}/results`, `${mark}-отчёт.txt`);
  const E = u.expert, base = `/api/orders/${kase.id}`;
  await ok(await E.req('POST', `${base}/messages`, { body: `Сообщение ${mark}` }), 201);
  await ok(await u.head.req('POST', `${base}/org-chat`, { body: `Внутреннее ${mark}` }), 201);
  await ok(await E.req('POST', `${base}/notes`, { body: `Заметка ${mark}` }), 201);
  await ok(await E.req('POST', `${base}/analogs`, { url: 'https://www.avito.ru/moskva/kvartiry/7731' }), 201);
  await ok(await E.req('POST', `${base}/doc-requests`, { items: ['egrn'] }), 201);
  await ok(await E.req('POST', `${base}/deadline-requests`, { new_deadline: addDays(todayMsk(), 20), reason: `Ждём выписку ${mark}` }), 201);
  await ok(await E.req('POST', `${base}/handover`, { reason: `Отпуск ${mark}` }), 201);
  await ok(await E.req('POST', `${base}/inspection`, {}), 201);
  const when = new Date(Date.now() + 3 * 86400_000).toISOString();
  await ok(await E.req('POST', `${base}/onsite`, { helper_id: u.helper.user.id, planned_at: when }), 201);
  await ok(await E.req('POST', '/api/specialist/me/dossier', { kind: 'sro', title: `СРО ${mark}`, number: '7731' }), 201);
  await ok(await E.req('POST', '/api/specialist/me/snippets', { kind: 'assumption', title: `Заготовка ${mark}`, body: `Текст ${mark}` }), 201);
  await ok(await u.head.req('POST', `/api/orgs/${org.id}/remarks`, { text: `Замечание ${mark}` }), 201);
  await ok(await u.head.req('POST', `/api/orgs/${org.id}/phrases`, { text: `Фраза ${mark}` }), 201);
  const invite = (await ok(await u.head.req('POST', `/api/orgs/${org.id}/invites`, { phone: `${prefix}6`, role: 'member' }), 201)).invite;
  const consultation = (await ok(await u.client.req('POST', '/api/ai/problem', { text: `Нужна оценка квартиры ${mark}` }), 201)).consultation;
  const one = async (q) => (await q)[0]?.id ?? null;
  return {
    u, org, personal, doc, kase, caseDoc, result, invite, consultation,
    note: await one(S.sql`select id from order_notes where order_id = ${kase.id}`),
    analog: await one(S.sql`select id from order_analogs where order_id = ${kase.id}`),
    docreq: await one(S.sql`select id from doc_requests where order_id = ${kase.id}`),
    deadlineReq: await one(S.sql`select id from deadline_requests where order_id = ${kase.id}`),
    handover: await one(S.sql`select id from handover_requests where order_id = ${kase.id}`),
    link: await one(S.sql`select id from inspection_links where order_id = ${kase.id}`),
    visit: await one(S.sql`select id from onsite_visits where order_id = ${kase.id}`),
    dossier: await one(S.sql`select id from dossier_items where user_id = ${u.expert.user.id}`),
    snippet: await one(S.sql`select id from snippets where user_id = ${u.expert.user.id}`),
    remark: await one(S.sql`select id from org_remarks where org_id = ${org.id} and kind = 'remark'`),
    phrase: await one(S.sql`select id from org_remarks where org_id = ${org.id} and kind <> 'remark'`),
  };
}

async function file(c, url, name) {
  const r = await c.req('POST', url, Buffer.from(`тестовый файл ${name}`), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 201, `${url}: ${JSON.stringify(r.body)}`);
  return r.body.document;
}

// Номер чужой записи (мир Б) для каждого вида номера в адресе.
function foreign(op, name) {
  const B = W.B;
  const p = op.path;
  const byName = {
    orderId: B.kase.id, userId: B.u.expert.user.id, nid: B.note, analog: B.analog, link: B.link, retake: 1, visit: B.visit,
    snippet: B.snippet, check: 'x', doc: B.result.id, n: 1, module: 'expertise', service: 'realty', code: 'x', step: 'original',
  };
  if (name === 'rid') {
    if (p.includes('/doc-requests/')) return B.docreq;
    if (p.includes('/handover/')) return B.handover;
    if (p.includes('/org-returns/')) return 1;
    return B.deadlineReq; // просьбы о переносе срока и «оставить перенос прежнего эксперта»
  }
  if (name === 'item') {
    if (p.includes('/remarks/')) return B.remark;
    if (p.includes('/phrases/')) return B.phrase;
    return B.dossier;
  }
  if (name === 'id') {
    const r = op.access?.resource;
    if (r === 'document') return B.caseDoc.id;
    if (r === 'orgDocument') return B.result.id;
    if (r === 'org' || r === 'orgTemplate') return B.org.id;
    if (r === 'orgInvite' || r === 'invite') return B.invite.id;
    if (r === 'specialistCard') return B.u.expert.user.id;
    if (r === 'consultation') return B.consultation.id;
    if (r === 'visit') return B.visit;
    if (p.startsWith('/api/admin/')) return B.u.expert.user.id;
    if (p.startsWith('/api/problems/')) return 1;
    return B.kase.id; // заявка, дело организации
  }
  if (!(name in byName)) throw new Error(`${op.id}: неизвестный номер :${name} — добавьте его в перебор`);
  return byName[name];
}

// Свой номер для главной части адреса (вид «своё + чужое вложенное»): заказчику — его заявка, руководителю и эксперту —
// дело своей организации, руководителю — своя организация. Нет своего — вида нет.
function own(op, who) {
  const A = W.A;
  const r = op.access?.resource;
  if (r === 'order' || r === 'orgCase') return who === 'client' ? A.personal.id : who === 'spec' ? null : A.kase.id;
  if (r === 'org' || r === 'orgTemplate') return who === 'head' || who === 'expert' ? A.org.id : null;
  return null;
}

// Несуществующий номер того же вида.
const GHOST = (x) => (/^[0-9a-f-]{36}$/i.test(String(x)) ? '00000000-0000-4000-8000-000000000000' : /^\d+$/.test(String(x)) ? '999999999' : x);

const ATTACKERS = ['client', 'head', 'expert', 'spec', 'helper'];
const DENIED = [403, 404];

// Всё, что есть у мира Б, — одной строкой: после перебора не должно измениться ничего.
async function snapshotB() {
  const B = W.B, orders = [B.personal.id, B.kase.id], users = Object.values(B.u).map((c) => c.user.id);
  const parts = await Promise.all([
    S.sql`select id, status, title, fields, price_kop, executor_user_id, offer_org_id, deadline from orders where id = any(${orders}) order by id`,
    S.sql`select id, deleted_at from documents where order_id = any(${orders}) order by id`,
    S.sql`select count(*)::int as n from order_messages where order_id = any(${orders})`,
    S.sql`select count(*)::int as n from org_messages where order_id = any(${orders})`,
    S.sql`select id, body, deleted_at, done_at from order_notes where order_id = any(${orders}) order by id`,
    S.sql`select id, deleted_at, url from order_analogs where order_id = any(${orders}) order by id`,
    S.sql`select id, cancelled_at from doc_requests where order_id = any(${orders}) order by id`,
    S.sql`select id, outcome from deadline_requests where order_id = any(${orders}) order by id`,
    S.sql`select id, outcome from handover_requests where order_id = any(${orders}) order by id`,
    S.sql`select id, revoked_at from inspection_links where order_id = any(${orders}) order by id`,
    S.sql`select id, cancelled_at, finished_at from onsite_visits where order_id = any(${orders}) order by id`,
    S.sql`select count(*)::int as n from document_signatures where document_id in (select id from documents where order_id = any(${orders}))`,
    S.sql`select user_id, role from org_members where org_id = ${B.org.id} order by user_id`,
    S.sql`select name from organizations where id = ${B.org.id}`,
    S.sql`select id, revoked_at, accepted_at, declined_at from org_invites where org_id = ${B.org.id} order by id`,
    S.sql`select id, deleted_at from org_remarks where org_id = ${B.org.id} order by id`,
    S.sql`select id, deleted_at, title from dossier_items where user_id = any(${users}) order by id`,
    S.sql`select id, deleted_at, title from snippets where user_id = any(${users}) order by id`,
    S.sql`select id, order_id from ai_consultations where id = ${B.consultation.id}`,
    S.sql`select count(*)::int as n from case_reminders where order_id = any(${orders})`,
  ]);
  return JSON.stringify(parts);
}

test('чужой номер в адресе — под каждой ролью, в каждой операции: только «нет доступа» или «не найдено», у чужих ничего не меняется', async () => {
  // Номера мира Б действительно есть — иначе перебор проверял бы пустоту.
  for (const k of ['note', 'analog', 'docreq', 'deadlineReq', 'handover', 'link', 'visit', 'dossier', 'snippet', 'remark', 'phrase']) {
    assert.ok(W.B[k], `в мире Б нет записи «${k}»`);
  }
  const ops = listOps(S.cfg, S.providers).filter((o) => o.auth === 'user' && /:[a-zA-Z]/.test(o.path));
  assert.ok(ops.length >= 120, `операций с номером в адресе: ${ops.length}`);
  const body = (o) => (o.method === 'GET' ? undefined : {
    from: 'in_work', to: 'cancelled', body: 'x', kind: 'assumption', title: 'x', text: 'x', reason: 'x', role: 'head', fixed: true, confirm: true, verified: true,
    specialist_id: W.A.u.expert.user.id, helper_id: W.A.u.helper.user.id, new_deadline: addDays(todayMsk(), 30), answer: 'x',
  });
  const before = await snapshotB();
  let tried = 0;
  for (const op of ops) {
    const names = [...op.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]);
    for (const who of ATTACKERS) {
      const c = W.A.u[who];
      const variants = [Object.fromEntries(names.map((n) => [n, foreign(op, n)]))];
      const mine = names.length > 1 && op.access?.param ? own(op, who) : null;
      if (mine) variants.push({ ...variants[0], [op.access.param]: mine });
      for (const v of variants) {
        const url = op.path.replace(/:([a-zA-Z]+)/g, (_, n) => encodeURIComponent(String(v[n])));
        const r = await c.req(op.method, url, body(op));
        tried++;
        const where = `${op.id} ${op.method} ${url} — ${who}${v === variants[1] ? ' (своё + чужое вложенное)' : ''}`;
        // «Неверно заполнено» (400) и «уже изменилось» (409) — только если тот же ответ и на несуществующий номер: ответ не
        // зависит от того, чья запись, и по нему не узнать, есть ли такая.
        if (r.status === 400 || r.status === 409) {
          const ghost = op.path.replace(/:([a-zA-Z]+)/g, (_, n) => (n in v && v[n] !== variants[0][n] ? v[n] : GHOST(v[n])));
          const g = await c.req(op.method, ghost, body(op));
          assert.deepEqual([g.status, g.body?.error], [r.status, r.body?.error], `${where}: на чужой и несуществующий номер ответы разные`);
        } else assert.ok(DENIED.includes(r.status), `${where}: ответ ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.ok(!JSON.stringify(r.body ?? '').includes(MARK), `${where}: в ответе чужое`);
      }
    }
  }
  assert.ok(tried >= 600, `проверок: ${tried}`);
  assert.equal(await snapshotB(), before, 'у мира Б ничего не изменилось');
  // Свои же номера тем же людям открываются — перебор не «зелёный оттого, что закрыто всё».
  const A = W.A;
  assert.equal((await A.u.client.req('GET', `/api/orders/${A.personal.id}`)).status, 200);
  assert.equal((await A.u.client.req('GET', `/api/documents/${A.doc.id}/link`)).status, 200);
  assert.equal((await A.u.expert.req('GET', `/api/orders/${A.kase.id}/notes`)).status, 200);
  assert.equal((await A.u.head.req('GET', `/api/orgs/${A.org.id}/cases`)).status, 200);
  assert.equal((await A.u.head.req('GET', `/api/specialists/${A.u.expert.user.id}/card`)).status, 200);
});

test('списки, «Сегодня», уведомления и профиль у людей мира А не содержат ничего из мира Б', async () => {
  for (const who of ATTACKERS) {
    const c = W.A.u[who];
    for (const url of ['/api/orders', '/api/today', '/api/notifications', '/api/me', '/api/specialist/me', '/api/orgs']) {
      const r = await c.req('GET', url);
      assert.ok(r.status < 500, `${who} ${url}: ${r.status}`);
      assert.ok(!JSON.stringify(r.body ?? '').includes(MARK), `${who} ${url}: чужое в ответе`);
    }
  }
});

// Ключи: вида ключей Яндекса, GitHub, закрытых ключей; и сами ключи сервера (тестовые) — ни в одном файле страниц,
// ни в отданном браузеру.
const KEY_RE = [/AQVN[0-9A-Za-z_-]{20,}/, /\bt1\.[0-9A-Za-z_-]{40,}/, /YC[A-Za-z0-9_-]{36,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bgh[pousr]_[0-9A-Za-z]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\b(live|test)_[0-9A-Za-z]{30,}/,
  /(password|passwd|secret|api_?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i];

test('ключей и паролей нет в страницах: ни в файлах public/, ни в том, что сервер отдаёт браузеру', async () => {
  const dir = path.resolve('public');
  const files = fs.readdirSync(dir).filter((f) => /\.(html|js|css)$/.test(f));
  assert.ok(files.length > 30);
  const secrets = [S.cfg.appSecret, TEST_TOKEN, BRIDGE_SECRET, S.cfg.stageLoginKey].filter((x) => x && x.length >= 16);
  const anon = client(S);
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const re of KEY_RE) assert.ok(!re.test(src), `${f}: похоже на ключ (${re})`);
    const r = await anon.req('GET', `/${f}`);
    assert.equal(r.status, 200, f);
    const served = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    for (const s of secrets) assert.ok(!served.includes(s), `${f}: сервер отдал ключ`);
  }
  for (const url of ['/', '/api/health']) {
    const r = await anon.req('GET', url);
    for (const s of secrets) assert.ok(!JSON.stringify(r.body ?? '').includes(s), `${url}: ключ в ответе`);
  }
});
