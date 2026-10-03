// Досье эксперта (2.14; решение Дамира 03.10.2026, в): эксперт сам ведёт свои документы в разделе «Специалист» —
// диплом, квалификационный аттестат, СРО, полисы оценщика и организации; копию загружает один раз, она хранится в
// хранилище РФ и по кнопке прикладывается к делу файлом результата («Приложить копии из досье»).
// Досье видит и меняет только сам эксперт; диспетчер в подборе и в списке специалистов видит только предупреждения
// об истёкших сроках (без номеров и копий). Правила — src/dossier/dossier.mjs.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { KINDS, dossierAlerts, loadDossier } from '../dossier/dossier.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit, text } from './util.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_MAX_RUB = 100_000_000_000;

function dateFrom(value, field, { future = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value);
  const d = new Date(`${v}T00:00:00Z`);
  if (!DATE_RE.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, 'bad_date', `Поле «${field}»: укажите дату`);
  if (v < '1950-01-01' || v > addDays(todayMsk(), future ? 20 * 365 : 0)) throw new HttpError(400, 'bad_date', `Поле «${field}»: дата вне допустимых пределов`);
  return v;
}

// Поля записи по виду: лишние для вида — отклоняются, обязательные — проверяются.
function itemFrom(body, kind) {
  const def = KINDS[kind];
  if (!def) throw new HttpError(400, 'bad_input', 'Выберите вид документа');
  const out = { title: text(body?.title, def.title, 300), number: null, issued_on: null, valid_until: null, amount_kop: null };
  const given = (k) => body?.[k] !== undefined && body[k] !== null && body[k] !== '';
  for (const k of ['number', 'issued_on', 'valid_until', 'amount_rub']) {
    const field = k === 'amount_rub' ? 'amount_kop' : k;
    if (given(k) && !def.has.includes(field)) throw new HttpError(400, 'bad_input', `У документа «${def.name}» нет поля ${k}`);
  }
  if (given('number')) out.number = text(body.number, def.number, 100);
  out.issued_on = dateFrom(body?.issued_on, 'Дата выдачи');
  out.valid_until = dateFrom(body?.valid_until, 'Действует до', { future: true });
  if (out.issued_on && out.valid_until && out.valid_until < out.issued_on) throw new HttpError(400, 'bad_date', 'Срок действия раньше даты выдачи');
  if (given('amount_rub')) {
    const rub = Number(body.amount_rub);
    if (!Number.isFinite(rub) || rub <= 0 || rub > AMOUNT_MAX_RUB) throw new HttpError(400, 'bad_input', 'Поле «Страховая сумма»: положительное число рублей');
    out.amount_kop = Math.round(rub * 100);
  }
  const missing = def.need.filter((f) => out[f] === null);
  if (missing.length) {
    const names = { number: def.number, valid_until: 'Действует до', amount_kop: 'Страховая сумма' };
    throw new HttpError(400, 'bad_input', `Для документа «${def.name}» заполните: ${missing.map((f) => names[f]).join(', ')}`);
  }
  return out;
}

async function requireSpecialist(sql, actor) {
  const sp = await sql.one`select 1 from specialists where user_id = ${actor.id}`;
  if (!sp) throw new HttpError(404, 'not_found', 'Вы не специалист');
}

// Своя запись досье — или «не найдено» (чужая запись выглядит так же, как несуществующая).
async function ownItem(sql, actor, id, { lock = false } = {}) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) throw new HttpError(404, 'not_found', 'Документ не найден');
  const row = lock
    ? await sql.one`select * from dossier_items where id = ${id} and user_id = ${actor.id} and deleted_at is null for update`
    : await sql.one`select * from dossier_items where id = ${id} and user_id = ${actor.id} and deleted_at is null`;
  if (!row) throw new HttpError(404, 'not_found', 'Документ не найден');
  return row;
}

async function view(sql, userId) {
  const items = await loadDossier(sql, userId);
  return {
    items,
    alerts: dossierAlerts(items),
    kinds: Object.entries(KINDS).map(([id, k]) => ({ id, name: k.name, title: k.title, number: k.number, has: k.has, need: k.need })),
  };
}

const extOf = (name) => (String(name).match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? '').toLowerCase();

export function dossierOps() {
  return [
    {
      id: 'dossier.get', method: 'GET', path: '/api/specialist/me/dossier', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        await requireSpecialist(sql, actor);
        return view(sql, actor.id);
      },
    },
    {
      id: 'dossier.add', method: 'POST', path: '/api/specialist/me/dossier', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        await requireSpecialist(sql, actor);
        const kind = String(body?.kind ?? '');
        const f = itemFrom(body, kind);
        const id = await sql.tx(async (tx) => {
          await tx`select 1 from specialists where user_id = ${actor.id} for update`;
          const n = await tx.one`select count(*)::int as n from dossier_items where user_id = ${actor.id} and deleted_at is null`;
          if (n.n >= MAX_ITEMS) throw new HttpError(409, 'too_many', `В досье — не больше ${MAX_ITEMS} документов`);
          const row = await tx.one`insert into dossier_items (user_id, kind, title, number, issued_on, valid_until, amount_kop)
                                   values (${actor.id}, ${kind}, ${f.title}, ${f.number}, ${f.issued_on}, ${f.valid_until}, ${f.amount_kop}) returning id`;
          await audit(tx, actor, 'dossier.add', 'dossier', row.id, { kind });
          return String(row.id);
        });
        res.status(201);
        return { id, ...(await view(sql, actor.id)) };
      },
    },
    {
      // Поправить сведения (новый аттестат или полис — новый номер и срок; напоминания пойдут по новому сроку).
      id: 'dossier.update', method: 'PUT', path: '/api/specialist/me/dossier/:item', auth: 'user', access: 'self',
      async handler({ sql, actor, params, body }) {
        await sql.tx(async (tx) => {
          const cur = await ownItem(tx, actor, params.item, { lock: true });
          const f = itemFrom(body, cur.kind);
          await tx`update dossier_items set title = ${f.title}, number = ${f.number}, issued_on = ${f.issued_on},
                     valid_until = ${f.valid_until}, amount_kop = ${f.amount_kop}, updated_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'dossier.update', 'dossier', cur.id, { kind: cur.kind });
        });
        return view(sql, actor.id);
      },
    },
    {
      // Убрать документ из досье. Запись и копия остаются в истории (по ним могли составить отчёт), в досье их больше нет.
      id: 'dossier.remove', method: 'DELETE', path: '/api/specialist/me/dossier/:item', auth: 'user', access: 'self',
      async handler({ sql, actor, params }) {
        await sql.tx(async (tx) => {
          const cur = await ownItem(tx, actor, params.item, { lock: true });
          await tx`update dossier_items set deleted_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'dossier.remove', 'dossier', cur.id, { kind: cur.kind });
        });
        return view(sql, actor.id);
      },
    },
    {
      // Копия документа (скан или фото) — один раз; новая заменяет прежнюю.
      id: 'dossier.file', method: 'POST', path: '/api/specialist/me/dossier/:item/file', auth: 'user', access: 'self',
      body: 'raw', limit: MAX_FILE_BYTES,
      async handler({ sql, actor, params, req, body, providers }) {
        const cur = await ownItem(sql, actor, params.item);
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
        let filename;
        try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
        const name = text(String(filename).replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
        const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
        const key = `dossier/${actor.id}/${crypto.randomUUID()}`;
        await providers.storage.put(key, body, mime);
        let old;
        try {
          old = await sql.tx(async (tx) => {
            const row = await ownItem(tx, actor, cur.id, { lock: true });
            await tx`update dossier_items set file_key = ${key}, file_name = ${name}, file_mime = ${mime}, file_size = ${body.length}, updated_at = now()
                     where id = ${row.id}`;
            await audit(tx, actor, 'dossier.file', 'dossier', row.id, { size: body.length });
            return row.file_key;
          });
        } catch (e) {
          await providers.storage.delete(key).catch(() => {});
          throw e;
        }
        if (old) await providers.storage.delete(old).catch(() => {});
        return view(sql, actor.id);
      },
    },
    {
      id: 'dossier.file.link', method: 'GET', path: '/api/specialist/me/dossier/:item/file', auth: 'user', access: 'self',
      async handler({ sql, actor, params, providers }) {
        const cur = await ownItem(sql, actor, params.item);
        if (!cur.file_key) throw new HttpError(404, 'not_found', 'Копия не загружена');
        return { url: await providers.storage.link(cur.file_key, { filename: cur.file_name }) };
      },
    },
    {
      // Приложить копии документов из досье к делу — файлами результата (приложения к отчёту; подписываются вместе с ним).
      // Только исполнитель своего дела в работе; уже приложенные (по имени файла) второй раз не добавляются.
      id: 'dossier.attach', method: 'POST', path: '/api/orders/:id/dossier', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, providers, res } = ctx;
        if (order.executor_user_id !== actor.id || !orderSides(actor, order).includes('executor')) throw new HttpError(403, 'forbidden', 'Копии из досье прикладывает исполнитель дела');
        if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Копии прикладываются, пока дело в работе');
        const items = (await loadDossier(sql, actor.id)).filter((i) => i.file);
        if (!items.length) throw new HttpError(409, 'no_copies', 'В досье нет загруженных копий — добавьте их в разделе «Специалист»');
        const have = new Set((await sql`select filename from documents where order_id = ${order.id} and kind = 'result' and deleted_at is null`).map((d) => d.filename));
        const added = [];
        let skipped = 0;
        for (const [k, i] of items.entries()) {
          const ext = extOf(i.file.name);
          const filename = `Приложение ${k + 1} — ${i.kind_name}${i.number ? ` № ${i.number}` : ''}`.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 240) + (ext ? `.${ext}` : '');
          if (have.has(filename)) { skipped += 1; continue; }
          const row = await sql.one`select file_key from dossier_items where id = ${i.id}`;
          const buf = await providers.storage.get(row.file_key);
          if (!buf) throw new HttpError(409, 'copy_missing', `Копия «${i.kind_name}» не найдена в хранилище — загрузите её заново`);
          added.push(publicDoc(await saveDocument(ctx, { filename, mime: i.file.mime, buf, kind: 'result' })));
        }
        await audit(sql, actor, 'dossier.attach', 'order', order.id, { added: added.length, skipped });
        res.status(added.length ? 201 : 200);
        return { documents: added, skipped };
      },
    },
  ];
}
