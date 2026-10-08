// Аналоги в деле (2.32; решение Дамира 04.10.2026 — план docs/analogi-plan.md, способ А). Эксперт сам находит объявление
// в своём браузере и прикладывает ссылку и скриншот (или PDF страницы); платформа ставит своё время получения и отпечаток
// файла, ИИ читает скриншот и предлагает признаки — эксперт проверяет и подтверждает (ИИ сам ничего не вносит). Подтверждённые
// аналоги идут в черновик, таблицей и приложением «Скриншоты объявлений» в файл Word. С сайтов платформа ничего не собирает.
// Видят исполнитель и диспетчер (как черновик), меняет только исполнитель, пока дело в работе. Правила — src/analogs/analogs.mjs.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { editsDraft, seesDraft } from '../access/policy.mjs';
import { ANALOG_TEXT_MAX, analogMessages, askAi, parseJsonAnswer } from '../ai/ai.mjs';
import { extractPages } from '../ai/extract.mjs';
import { OCR_MIME } from '../providers/ocr.mjs';
import { adjusted, adjustKinds, analogFields, analogWarnings, cleanAdjustments, cleanAnalogValues, cleanUrl, hostOf, listPositions, missingAnalog, searchHints, suggestionValues } from '../analogs/analogs.mjs';
import { audit, text as textFrom } from './util.mjs';

// Облако принимает запрос не больше 3,5 МБ (Yandex Serverless Containers) — через ядро только до 3 МБ (2.49).
export const ANALOG_FILE_MAX = 3 * 1024 * 1024;
export const MAX_ANALOGS = 20;

// Вид файла — по его содержимому, а не по имени: скриншот (png, jpeg, webp, heic) или PDF страницы.
export function fileKind(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|hevc)$/.test(buf.subarray(8, 12).toString('latin1'))) return { mime: 'image/heic', ext: 'heic' };
  return null;
}

function guard(actor, order, spec) {
  if (!seesDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Аналоги видят исполнитель и диспетчер');
  if (!spec) throw new HttpError(404, 'not_found', 'Для этой услуги раздела «Аналоги» нет');
}

function guardEdit(actor, order, spec) {
  guard(actor, order, spec);
  if (!editsDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Аналоги добавляет и правит исполнитель, пока дело в работе');
}

const idFrom = (v) => {
  if (!/^\d{1,18}$/.test(String(v ?? ''))) throw new HttpError(404, 'not_found', 'Аналог не найден');
  return String(v);
};

// Аналог этого дела — или «не найдено» (аналог другого дела выглядит так же, как несуществующий).
async function ownAnalog(sql, order, id, { lock = false } = {}) {
  const aid = idFrom(id);
  const row = lock
    ? await sql.one`select * from order_analogs where id = ${aid} and order_id = ${order.id} and deleted_at is null for update`
    : await sql.one`select * from order_analogs where id = ${aid} and order_id = ${order.id} and deleted_at is null`;
  if (!row) throw new HttpError(404, 'not_found', 'Аналог не найден');
  return row;
}

export const loadAnalogs = (sql, orderId) => sql`select * from order_analogs where order_id = ${orderId} and deleted_at is null order by id`;

const publicAnalog = (a, warnings) => ({
  id: String(a.id),
  url: a.url,
  host: hostOf(a.url),
  fields: a.fields,
  adjustments: a.adjustments ?? [],
  adjusted: adjusted(a),
  suggested: a.suggested,
  ai_model: a.ai_model,
  confirmed: !!a.confirmed_at,
  confirmed_at: a.confirmed_at,
  file: a.file_key ? { name: a.file_name, mime: a.file_mime, size: a.file_size, sha256: a.file_sha256, received_at: a.received_at } : null,
  warnings: warnings ?? [],
  // Взят из своего прошлого дела с тем же объектом (2.118): подтверждение снято — сверить объявление на новую дату.
  copied: !!a.copied_from,
});

async function view({ sql, actor, order, registry, providers }) {
  const spec = registry.analogs(order.module, order.service);
  const list = await loadAnalogs(sql, order.id);
  const { per, hints, confirmed, min } = analogWarnings(spec, order, list);
  // Исполнитель отметил, что сравнительный подход не применяется (2.33), — аналоги не нужны, не напоминаем о них.
  const needed = !(order.approaches?.length && !order.approaches.includes('comparative'));
  return {
    analogs: list.map((a) => publicAnalog(a, per.get(a.id))),
    fields: analogFields(spec),
    adjust_kinds: adjustKinds(spec).map(({ id, name }) => ({ id, name })),
    min: needed ? min : 0,
    needed,
    confirmed,
    hints: needed ? hints : ['Сравнительный подход не применяется — аналоги не нужны (подходы отмечены в черновике)', ...hints.filter((h) => !h.startsWith('Нужно не меньше'))],
    search: searchHints(registry, order),
    can_edit: editsDraft(actor, order),
    ocr: !!providers.ocr,
  };
}

// Текст объявления для ИИ: распознанный со скриншота, из PDF страницы и/или вставленный экспертом. Нигде не хранится.
async function adText(providers, a, pasted) {
  const parts = [];
  if (pasted) parts.push(pasted);
  if (a.file_key) {
    const buf = await providers.storage.get(a.file_key);
    if (buf && a.file_mime === 'application/pdf') {
      const got = await extractPages(buf, a.file_name, a.file_mime);
      if (got) parts.push(got.pages.join('\n'));
    } else if (buf && providers.ocr && OCR_MIME.includes(a.file_mime)) {
      try { parts.push((await providers.ocr.recognize({ buf, mime: a.file_mime })).text); } catch (e) { console.error('Распознавание скриншота не удалось:', e?.message || e); }
    }
  }
  return parts.filter((p) => p && p.trim()).join('\n').slice(0, ANALOG_TEXT_MAX);
}

export function analogOps() {
  return [
    {
      id: 'analogs.list', method: 'GET', path: '/api/orders/:id/analogs', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        guard(ctx.actor, ctx.order, ctx.registry.analogs(ctx.order.module, ctx.order.service));
        return view(ctx);
      },
    },
    {
      // Новый аналог — по ссылке. Повтор ссылки в деле не запрещён, но сразу виден предупреждением.
      id: 'analogs.add', method: 'POST', path: '/api/orders/:id/analogs', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, body, res } = ctx;
        const spec = registry.analogs(order.module, order.service);
        guardEdit(actor, order, spec);
        const u = cleanUrl(body?.url);
        const id = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const n = await tx.one`select count(*)::int as n from order_analogs where order_id = ${order.id} and deleted_at is null`;
          if (n.n >= MAX_ANALOGS) throw new HttpError(409, 'too_many', `В деле — не больше ${MAX_ANALOGS} аналогов`);
          const row = await tx.one`insert into order_analogs (order_id, author_id, url, url_key) values (${order.id}, ${actor.id}, ${u.url}, ${u.key}) returning id`;
          await audit(tx, actor, 'analogs.add', 'order', order.id, { analog: String(row.id), host: u.host });
          return String(row.id);
        });
        res.status(201);
        return { id, ...(await view(ctx)) };
      },
    },
    {
      // Скриншот или PDF страницы объявления. Время получения — время платформы (не время из файла), отпечаток — SHA-256:
      // потом видно, что файл не меняли. Новый файл заменяет прежний; подтверждение снимается — признаки надо сверить заново.
      id: 'analogs.file', method: 'POST', path: '/api/orders/:id/analogs/:analog/file', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' }, body: 'raw', limit: ANALOG_FILE_MAX,
      async handler(ctx) {
        const { sql, actor, order, registry, providers, params, req, body } = ctx;
        guardEdit(actor, order, registry.analogs(order.module, order.service));
        const cur = await ownAnalog(sql, order, params.analog);
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
        const kind = fileKind(body);
        if (!kind) throw new HttpError(400, 'bad_file', 'Приложите снимок экрана (JPEG, PNG, WEBP, HEIC) или PDF страницы объявления');
        let filename;
        try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
        const base = String(filename).replace(/[\\/\u0000-\u001f]/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || 'Скриншот объявления';
        const name = textFrom(`${base.slice(0, 240)}.${kind.ext}`, 'Имя файла', 255);
        const sha = crypto.createHash('sha256').update(body).digest('hex');
        const key = `analogs/${order.id}/${crypto.randomUUID()}`;
        await providers.storage.put(key, body, kind.mime);
        let old;
        try {
          old = await sql.tx(async (tx) => {
            const row = await ownAnalog(tx, order, cur.id, { lock: true });
            await tx`update order_analogs set file_key = ${key}, file_name = ${name}, file_mime = ${kind.mime}, file_size = ${body.length},
                       file_sha256 = ${sha}, received_at = now(), confirmed_at = null, updated_at = now() where id = ${row.id}`;
            await audit(tx, actor, 'analogs.file', 'order', order.id, { analog: String(row.id), size: body.length, sha256: sha });
            return row.file_key;
          });
        } catch (e) {
          await providers.storage.delete(key).catch(() => {});
          throw e;
        }
        if (old) await providers.storage.delete(old).catch(() => {});
        return view(ctx);
      },
    },
    {
      id: 'analogs.file.link', method: 'GET', path: '/api/orders/:id/analogs/:analog/file', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, params }) {
        guard(actor, order, registry.analogs(order.module, order.service));
        const a = await ownAnalog(sql, order, params.analog);
        if (!a.file_key) throw new HttpError(404, 'not_found', 'Скриншот не загружен');
        return { url: await providers.storage.link(a.file_key, { filename: a.file_name }) };
      },
    },
    {
      // ИИ читает скриншот (или PDF, или вставленный текст) и предлагает признаки. Пустые признаки заполняются предложением,
      // то, что эксперт уже ввёл, не трогается. Подтверждение — только человеком (analogs.update с confirm).
      id: 'analogs.ai', method: 'POST', path: '/api/orders/:id/analogs/:analog/ai', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, providers, params, body } = ctx;
        const spec = registry.analogs(order.module, order.service);
        guardEdit(actor, order, spec);
        const a = await ownAnalog(sql, order, params.analog);
        const pasted = typeof body?.text === 'string' ? body.text.slice(0, ANALOG_TEXT_MAX).trim() : '';
        const ad = await adText(providers, a, pasted);
        if (!ad) {
          throw new HttpError(409, 'no_text', a.file_key && (providers.ocr || a.file_mime === 'application/pdf')
            ? 'На файле не удалось прочитать текст — вставьте текст объявления (выделить всё → скопировать) или заполните признаки сами'
            : 'Вставьте текст объявления (выделить всё → скопировать) или приложите скриншот или PDF страницы — по ним ИИ предложит признаки');
        }
        const out = await askAi(ctx, actor, 'analog', analogMessages({ fields: analogFields(spec), url: a.url, text: ad, positions: listPositions(spec, order) }));
        const got = suggestionValues(spec, parseJsonAnswer(out.text)?.fields);
        await sql.tx(async (tx) => {
          const row = await ownAnalog(tx, order, a.id, { lock: true });
          const merged = { ...got, ...row.fields };
          const changed = Object.keys(merged).length !== Object.keys(row.fields).length;
          await tx`update order_analogs set suggested = ${JSON.stringify(got)}, ai_model = ${out.model}, fields = ${JSON.stringify(merged)},
                     confirmed_at = ${changed ? null : row.confirmed_at}, updated_at = now() where id = ${row.id}`;
          await audit(tx, actor, 'analogs.ai', 'order', order.id, { analog: String(row.id), fields: Object.keys(got).length });
        });
        return { found: Object.keys(got).length, ...(await view(ctx)) };
      },
    },
    {
      // Признаки от эксперта (целиком, как на экране). confirm: true — «Подтверждаю»: обязательные признаки должны быть.
      // adjustments — корректировки к аналогу (2.74), тоже целиком; не переданы — остаются прежние.
      id: 'analogs.update', method: 'PUT', path: '/api/orders/:id/analogs/:analog', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, params, body } = ctx;
        const spec = registry.analogs(order.module, order.service);
        guardEdit(actor, order, spec);
        const fields = cleanAnalogValues(spec, body?.fields);
        const adjustments = body?.adjustments === undefined ? null : cleanAdjustments(spec, body.adjustments);
        const confirm = body?.confirm === true;
        if (confirm) {
          const miss = missingAnalog(spec, fields);
          if (miss.length) throw new HttpError(400, 'bad_input', `Чтобы подтвердить, заполните: ${miss.join(', ')}`);
        }
        await sql.tx(async (tx) => {
          const row = await ownAnalog(tx, order, params.analog, { lock: true });
          if (confirm && !row.file_key) throw new HttpError(409, 'no_file', 'Сначала приложите скриншот объявления');
          await tx`update order_analogs set fields = ${JSON.stringify(fields)}, confirmed_at = ${confirm ? new Date() : null},
                     adjustments = ${JSON.stringify(adjustments ?? row.adjustments)}, updated_at = now() where id = ${row.id}`;
          await audit(tx, actor, 'analogs.update', 'order', order.id, { analog: String(row.id), confirm, adjustments: (adjustments ?? row.adjustments).length });
        });
        return view(ctx);
      },
    },
    {
      // Убрать аналог из дела. Запись и скриншот остаются в истории (по ним могли составить отчёт).
      id: 'analogs.remove', method: 'DELETE', path: '/api/orders/:id/analogs/:analog', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, params } = ctx;
        guardEdit(actor, order, registry.analogs(order.module, order.service));
        await sql.tx(async (tx) => {
          const row = await ownAnalog(tx, order, params.analog, { lock: true });
          await tx`update order_analogs set deleted_at = now() where id = ${row.id}`;
          await audit(tx, actor, 'analogs.remove', 'order', order.id, { analog: String(row.id) });
        });
        return view(ctx);
      },
    },
  ];
}
