// Дистанционный осмотр (задача 2.3). Исполнитель, пока дело у него в работе, выдаёт владельцу объекта ссылку: без входа,
// на ограниченное время, только по одной заявке. Владелец по шагам из описания модуля снимает объект; у каждого фото —
// время и геометка телефона. Фото ложатся в документы заявки (вид «осмотр») — в деле у эксперта.
// Секрет ссылки — только в адресе после «#» (в журналы серверов и в Referer не попадает); странице он нужен в заголовке
// x-inspect-token. В базе — только отпечаток секрета. Владелец видит лишь название услуги и шаги — ни имён, ни заявки.
// Задача 2.20: ссылку платформа может сразу отправить владельцу СМС (номер не хранится — только скрытый), а эксперт —
// попросить переснять шаг: владелец видит просьбу у шага, новое фото этого шага её закрывает.
import crypto from 'node:crypto';
import { HttpError, notFound, rateLimiter } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { notify } from '../notify/notify.mjs';
import { audit, phoneFrom, text } from './util.mjs';

export const INSPECT = {
  days: [1, 3, 7],       // на сколько дней выдаётся ссылка (по умолчанию — 3)
  photosMax: 120,        // фото по одной ссылке (2.49: дом с участком — до 100 снимков)
  perStepMax: 12,        // фото на один шаг
  fileMax: 3 * 1024 * 1024,   // облако: запрос не больше 3,5 МБ (2.49); фото уменьшаются на телефоне
  smsPerDay: 5,          // СМС со ссылкой по одной заявке за сутки — от рассылки по чужим номерам
  noteMax: 300,          // просьба переснять: что не так
};
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// «+7 *** ***-12-34»: эксперт видит, куда ушла СМС; полный номер владельца в базе не хранится.
export const maskPhone = (phone) => `+7 *** ***-${phone.slice(-4, -2)}-${phone.slice(-2)}`;

// Открытые просьбы переснять: шаг → { id, note, requested_at }.
export async function openRetakes(sql, orderId) {
  const rows = await sql`select id, step, note, requested_at from inspection_retakes
                         where order_id = ${orderId} and closed_at is null order by id`;
  return Object.fromEntries(rows.map((r) => [r.step, { id: String(r.id), note: r.note, requested_at: r.requested_at }]));
}

// Текст СМС владельцу: без имён, адреса и номера заявки — только ссылка.
export const smsInspectText = (url, retakes) => (retakes
  ? `БЕРТЕЛ Дело: эксперт просит переснять фото объекта. Ссылка: ${url}`
  : `БЕРТЕЛ Дело: сфотографируйте объект для эксперта по ссылке ${url}`);

// Снимок ли это на самом деле (по первым байтам), а не что-то под видом картинки.
export function looksLikeImage(buf, mime) {
  if (buf.length < 12) return false;
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  return buf.toString('latin1', 4, 8) === 'ftyp'; // HEIC/HEIF
}

// Ссылка действует: не истекла, не отозвана, «Готово» не нажато, дело в работе у того, кто её выдал.
export const linkState = (link, order) => {
  if (link.revoked_at) return 'revoked';
  if (link.finished_at) return 'finished';
  if (new Date(link.expires_at) <= new Date()) return 'expired';
  if (order.status !== 'in_work' || order.executor_user_id !== link.created_by) return 'closed';
  return 'active';
};

const canIssue = (actor, order) => order.status === 'in_work' && orderSides(actor, order).includes('executor');

function numberOrNull(v, min, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
}

// Геометка и время съёмки из заголовков страницы. Неверные значения — ошибка (а не тихое «без геометки»).
export function shotMeta(get) {
  const lat = numberOrNull(get('x-lat'), -90, 90);
  const lon = numberOrNull(get('x-lon'), -180, 180);
  const acc = numberOrNull(get('x-accuracy'), 0, 100_000);
  if ([lat, lon, acc].some(Number.isNaN) || (lat === null) !== (lon === null)) throw new HttpError(400, 'bad_geo', 'Неверная геометка');
  let shotAt = null;
  const raw = get('x-shot-at');
  if (raw) {
    const t = new Date(raw);
    // Часы телефона могут врать; время дальше суток от сервера не записываем — остаётся время получения.
    if (!Number.isNaN(t.getTime()) && Math.abs(t.getTime() - Date.now()) <= 24 * 3600_000) shotAt = t.toISOString();
  }
  return { lat, lon, accuracy: lat === null ? null : acc, shotAt };
}

// Ссылка по секрету из заголовка; нет, чужая форма или недействительна — «не найдено» (без подробностей, почему).
async function linkByToken(sql, req, { lock = false } = {}) {
  const token = req.get('x-inspect-token') || '';
  if (!TOKEN_RE.test(token)) throw notFound();
  const link = lock
    ? await sql.one`select * from inspection_links where token_hash = ${hashToken(token)} for update`
    : await sql.one`select * from inspection_links where token_hash = ${hashToken(token)}`;
  if (!link) throw notFound();
  const order = await sql.one`select * from orders where id = ${link.order_id}`;
  return { link, order, state: linkState(link, order) };
}

// Сколько фото по каждому шагу: по ссылке владельца ({ link }) или по выезду помощника ({ visit }, задача 2.4).
export async function stepCounts(sql, source) {
  const rows = source.visit
    ? await sql`select step, count(*)::int as n from inspection_photos where visit_id = ${source.visit} group by step`
    : await sql`select step, count(*)::int as n from inspection_photos where link_id = ${source.link} group by step`;
  return Object.fromEntries(rows.map((r) => [r.step, r.n]));
}

// Принять фото осмотра (тело запроса — снимок; шаг, время и геометка — в заголовках): проверка, лимиты, файл в хранилище,
// документ заявки вида «осмотр» и строка фото — одной записью. Общее для ссылки владельца (2.3) и выезда помощника (2.4).
export async function storePhoto(ctx, { order, steps, uploadedBy, source, actor }) {
  const { sql, req, body } = ctx;
  const step = steps.find((s) => s.id === req.get('x-step'));
  if (!step) throw new HttpError(400, 'bad_step', 'Неизвестный шаг осмотра');
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
  const mime = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME.includes(mime) || !looksLikeImage(body, mime)) throw new HttpError(400, 'not_image', 'Нужна фотография (JPEG, PNG, WebP или HEIC)');
  const meta = shotMeta((h) => req.get(h));
  // Номер снимка со страницы (2.68): повтор после потерянного ответа не создаёт второе фото.
  const clientId = req.get('x-photo-id') || null;
  if (clientId !== null && !CLIENT_ID_RE.test(clientId)) throw new HttpError(400, 'bad_photo_id', 'Неверный номер снимка');
  const counts = await stepCounts(sql, source);
  const sameShot = async (db) => (clientId === null ? null : source.visit
    ? db.one`select step from inspection_photos where visit_id = ${source.visit} and client_id = ${clientId}`
    : db.one`select step from inspection_photos where link_id = ${source.link} and client_id = ${clientId}`);
  const already = await sameShot(sql);
  if (already) return { step: already.step, photos: counts[already.step] ?? 0, geo: meta.lat !== null, repeated: true };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total >= INSPECT.photosMax) throw new HttpError(409, 'too_many', `За один осмотр — не больше ${INSPECT.photosMax} фото`);
  if ((counts[step.id] ?? 0) >= INSPECT.perStepMax) throw new HttpError(409, 'too_many', `На один шаг — не больше ${INSPECT.perStepMax} фото`);
  // Имя файла — шаг и номер: по нему эксперт и черновик заключения (2.2) понимают, что на снимке. Номер — по всей заявке:
  // пересъёмка по новой ссылке (2.20) не повторяет имя прежнего фото.
  const [prev] = await sql`select count(*)::int as n from inspection_photos p join documents d on d.id = p.document_id
                           where d.order_id = ${order.id} and p.step = ${step.id}`;
  const filename = `Осмотр · ${step.title} · ${prev.n + 1}.${EXT[mime]}`;
  const key = `orders/${order.id}/${crypto.randomUUID()}`;
  await ctx.providers.storage.put(key, body, mime);
  try {
    await sql.tx(async (tx) => {
      const d = await tx.one`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
                             values (${order.id}, ${uploadedBy}, ${filename}, ${mime}, ${body.length}, ${key}, 'inspection') returning id`;
      await tx`insert into inspection_photos (document_id, link_id, visit_id, step, shot_at, lat, lon, accuracy_m, client_id)
               values (${d.id}, ${source.link ?? null}, ${source.visit ?? null}, ${step.id}, ${meta.shotAt}, ${meta.lat}, ${meta.lon}, ${meta.accuracy}, ${clientId})`;
      const where = source.visit ? { visit: String(source.visit) } : { link: String(source.link) };
      await audit(tx, actor, source.visit ? 'onsite.photo' : 'inspect.photo', 'order', order.id, { ...where, document: d.id, step: step.id, geo: meta.lat !== null });
      // Новое фото шага закрывает просьбу переснять его (2.20).
      await tx`update inspection_retakes set closed_at = now(), closed_reason = 'photo'
               where order_id = ${order.id} and step = ${step.id} and closed_at is null`;
    });
  } catch (e) {
    await ctx.providers.storage.delete(key).catch(() => {});
    // Два повтора одного снимка пришли одновременно: второй — не ошибка, фото уже есть.
    if (e.code === '23505' && clientId !== null) {
      const now = await stepCounts(sql, source);
      return { step: step.id, photos: now[step.id] ?? 0, geo: meta.lat !== null, repeated: true };
    }
    throw e;
  }
  return { step: step.id, photos: (counts[step.id] ?? 0) + 1, geo: meta.lat !== null };
}

const STATE_RU = {
  revoked: 'Ссылку отозвал эксперт',
  finished: 'Осмотр завершён — фото переданы эксперту',
  expired: 'Срок ссылки истёк',
  closed: 'Осмотр по этой ссылке закрыт',
};

const linkView = (l, order, photos) => ({
  id: String(l.id), created_at: l.created_at, expires_at: l.expires_at, revoked_at: l.revoked_at, finished_at: l.finished_at,
  state: linkState(l, order), photos, sms_to: l.sms_to ?? null, sms_sent_at: l.sms_sent_at ?? null,
});

export function inspectOps() {
  // Владелец без входа: лимит по адресу (секрет ссылки — 256 бит, перебор бесполезен; лимит — от засорения).
  const ownerLimit = rateLimiter({ windowMs: 10 * 60_000, max: 300 });

  return [
    {
      // Осмотр в деле: ссылки (без секрета) и фото по шагам с временем и геометкой. Видит каждый, кто видит заявку.
      id: 'inspection.get', method: 'GET', path: '/api/orders/:id/inspection', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        const steps = registry.inspectionSteps(order.module, order.service);
        const links = await sql`select l.*, (select count(*)::int from inspection_photos p where p.link_id = l.id) as photos
                                from inspection_links l where l.order_id = ${order.id} order by l.id desc`;
        const photos = await sql`
          select p.*, d.filename, d.size_bytes from inspection_photos p join documents d on d.id = p.document_id
          where d.order_id = ${order.id} and d.deleted_at is null order by p.received_at, d.id`;
        const byStep = (id) => photos.filter((p) => p.step === id).map((p) => ({
          document_id: p.document_id, filename: p.filename, size_bytes: p.size_bytes,
          link_id: p.link_id === null ? null : String(p.link_id), visit_id: p.visit_id === null ? null : String(p.visit_id),
          received_at: p.received_at, shot_at: p.shot_at,
          geo: p.lat === null ? null : { lat: p.lat, lon: p.lon, accuracy_m: p.accuracy_m === null ? null : Math.round(p.accuracy_m) },
        }));
        const retakes = await openRetakes(sql, order.id);
        return {
          steps: steps.map((s) => ({ ...s, photos: byStep(s.id), retake: retakes[s.id] ?? null })),
          links: links.map((l) => linkView(l, order, l.photos)),
          can_issue: canIssue(actor, order) && steps.length > 0,
          days: INSPECT.days,
          note_max: INSPECT.noteMax,
        };
      },
    },
    {
      // Выдать ссылку владельцу. Прежняя действующая ссылка отзывается: у осмотра одна ссылка за раз.
      // С номером телефона (2.20) платформа сразу шлёт владельцу СМС со ссылкой; не ушла — ссылка всё равно выдана.
      id: 'inspection.issue', method: 'POST', path: '/api/orders/:id/inspection', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, body, res, req, cfg, providers }) {
        if (!canIssue(actor, order)) throw new HttpError(403, 'forbidden', 'Ссылку на осмотр выдаёт исполнитель, пока дело в работе');
        if (!registry.inspectionSteps(order.module, order.service).length) throw new HttpError(400, 'no_inspection', 'Для этой услуги дистанционный осмотр не предусмотрен');
        const days = body?.days === undefined ? 3 : body.days;
        if (!INSPECT.days.includes(days)) throw new HttpError(400, 'bad_input', `Срок ссылки — ${INSPECT.days.join(', ')} дн.`);
        const phone = body?.phone === undefined || body.phone === null || body.phone === '' ? null : phoneFrom(body.phone);
        const token = crypto.randomBytes(32).toString('base64url');
        const link = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          if (phone) {
            const sent = await tx.one`select count(*)::int as n from inspection_links
                                      where order_id = ${order.id} and sms_sent_at > now() - interval '1 day'`;
            if (sent.n >= INSPECT.smsPerDay) throw new HttpError(429, 'sms_limit', `По одной заявке — не больше ${INSPECT.smsPerDay} СМС со ссылкой в сутки. Скопируйте ссылку и отправьте сами.`);
          }
          await tx`update inspection_links set revoked_at = now()
                   where order_id = ${order.id} and revoked_at is null and finished_at is null and expires_at > now()`;
          const l = await tx.one`insert into inspection_links (order_id, created_by, token_hash, expires_at)
                                 values (${order.id}, ${actor.id}, ${hashToken(token)}, now() + make_interval(days => ${days}))
                                 returning *`;
          await audit(tx, actor, 'inspection.issue', 'order', order.id, { link: String(l.id), days, sms: Boolean(phone) });
          return l;
        });
        const path = `/osmotr#${token}`;
        let sms = null;
        if (phone) {
          // СМС — сразу, не через очередь: в очереди лежал бы текст с секретом ссылки.
          const base = cfg?.publicUrl || `${req.protocol}://${req.get('host')}`;
          const retakes = Object.keys(await openRetakes(sql, order.id)).length;
          try {
            await providers.sms.send({ phone, text: smsInspectText(base + path, retakes) });
            const to = maskPhone(phone);
            const [l] = await sql`update inspection_links set sms_to = ${to}, sms_sent_at = now() where id = ${link.id} returning *`;
            Object.assign(link, l);
            await audit(sql, actor, 'inspection.sms', 'order', order.id, { link: String(link.id), to });
            sms = 'sent';
          } catch (e) {
            console.error('СМС со ссылкой осмотра:', e?.message || e);
            sms = 'failed';
          }
        }
        res.status(201);
        // Секрет отдаётся один раз: в базе его нет, потерянную ссылку не восстановить — только выдать новую.
        return { link: linkView(link, order, 0), path, sms };
      },
    },
    {
      id: 'inspection.revoke', method: 'DELETE', path: '/api/orders/:id/inspection/:link', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params }) {
        if (!canIssue(actor, order)) throw new HttpError(403, 'forbidden', 'Отозвать ссылку может исполнитель, пока дело в работе');
        if (!/^\d{1,18}$/.test(params.link)) throw notFound();
        await sql.tx(async (tx) => {
          const l = await tx.one`update inspection_links set revoked_at = coalesce(revoked_at, now())
                                 where id = ${params.link} and order_id = ${order.id} returning id`;
          if (!l) throw notFound();
          await audit(tx, actor, 'inspection.revoke', 'order', order.id, { link: String(l.id) });
        });
      },
    },
    {
      // Попросить переснять шаг (2.20): что не так — владельцу у шага; повторная просьба по шагу заменяет текст.
      id: 'inspection.retake', method: 'POST', path: '/api/orders/:id/inspection/retakes', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, body, res }) {
        if (!canIssue(actor, order)) throw new HttpError(403, 'forbidden', 'Попросить переснять может исполнитель, пока дело в работе');
        const step = registry.inspectionSteps(order.module, order.service).find((s) => s.id === body?.step);
        if (!step) throw new HttpError(400, 'bad_step', 'Неизвестный шаг осмотра');
        const note = text(body?.note, 'Что переснять', INSPECT.noteMax);
        const r = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const cur = await tx.one`update inspection_retakes set note = ${note}, requested_at = now()
                                   where order_id = ${order.id} and step = ${step.id} and closed_at is null returning *`;
          const row = cur ?? await tx.one`insert into inspection_retakes (order_id, step, note, requested_by)
                                          values (${order.id}, ${step.id}, ${note}, ${actor.id}) returning *`;
          await audit(tx, actor, 'inspection.retake', 'order', order.id, { retake: String(row.id), step: step.id });
          return row;
        });
        const active = await sql.one`select 1 as x from inspection_links where order_id = ${order.id} and revoked_at is null
                                     and finished_at is null and expires_at > now() and created_by = ${actor.id}`;
        res.status(201);
        // active_link: владелец увидит просьбу, открыв действующую ссылку; нет — нужна новая ссылка.
        return { retake: { id: String(r.id), step: r.step, note: r.note, requested_at: r.requested_at }, active_link: Boolean(active) };
      },
    },
    {
      id: 'inspection.retake_cancel', method: 'DELETE', path: '/api/orders/:id/inspection/retakes/:retake', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params }) {
        if (!canIssue(actor, order)) throw new HttpError(403, 'forbidden', 'Отменить просьбу может исполнитель, пока дело в работе');
        if (!/^\d{1,18}$/.test(params.retake)) throw notFound();
        await sql.tx(async (tx) => {
          const r = await tx.one`update inspection_retakes set closed_at = now(), closed_reason = 'cancelled'
                                 where id = ${params.retake} and order_id = ${order.id} and closed_at is null returning id, step`;
          if (!r) throw notFound();
          await audit(tx, actor, 'inspection.retake_cancel', 'order', order.id, { retake: String(r.id), step: r.step });
        });
      },
    },
    {
      id: 'inspect.view', method: 'GET', path: '/api/inspect', auth: 'public',
      publicReason: 'страница осмотра для владельца объекта: только по секрету ссылки, только шаги и число фото по одной заявке',
      rateLimit: (ip) => ownerLimit(ip),
      async handler({ sql, req, registry }) {
        const { link, order, state } = await linkByToken(sql, req);
        if (state !== 'active') return { active: false, message: STATE_RU[state] };
        const def = registry.service(order.module, order.service);
        const counts = await stepCounts(sql, { link: link.id });
        const retakes = await openRetakes(sql, order.id);
        return {
          active: true,
          service: def?.service.name ?? null,
          expires_at: link.expires_at,
          steps: registry.inspectionSteps(order.module, order.service)
            .map((s) => ({ ...s, photos: counts[s.id] ?? 0, retake: retakes[s.id]?.note ?? null })),
          limits: { photos: INSPECT.photosMax, per_step: INSPECT.perStepMax, file_bytes: INSPECT.fileMax },
        };
      },
    },
    {
      id: 'inspect.photo', method: 'POST', path: '/api/inspect/photos', auth: 'public',
      publicReason: 'владелец объекта присылает фото осмотра по секрету ссылки; только снимки, лимиты по числу и размеру',
      rateLimit: (ip) => ownerLimit(ip),
      body: 'raw', limit: INSPECT.fileMax,
      async handler(ctx) {
        const { sql, req, registry, res } = ctx;
        const { link, order, state } = await linkByToken(sql, req);
        if (state !== 'active') throw new HttpError(410, 'link_inactive', STATE_RU[state]);
        // Документ — от имени выдавшего ссылку исполнителя (в деле он его).
        const out = await storePhoto(ctx, { order, steps: registry.inspectionSteps(order.module, order.service),
          uploadedBy: link.created_by, source: { link: link.id }, actor: null });
        res.status(201);
        return out;
      },
    },
    {
      // «Готово»: ссылка закрывается, исполнитель получает уведомление. Пропущенные шаги эксперт увидит у себя.
      id: 'inspect.finish', method: 'POST', path: '/api/inspect/finish', auth: 'public',
      publicReason: 'владелец объекта завершает осмотр по секрету ссылки; ссылка после этого не действует',
      rateLimit: (ip) => ownerLimit(ip),
      async handler({ sql, req }) {
        return sql.tx(async (tx) => {
          const { link, order, state } = await linkByToken(tx, req, { lock: true });
          if (state !== 'active') throw new HttpError(410, 'link_inactive', STATE_RU[state]);
          const n = Object.values(await stepCounts(tx, { link: link.id })).reduce((a, b) => a + b, 0);
          if (!n) throw new HttpError(409, 'no_photos', 'Сначала сделайте хотя бы одно фото');
          await tx`update inspection_links set finished_at = now() where id = ${link.id}`;
          await audit(tx, null, 'inspect.finish', 'order', order.id, { link: String(link.id), photos: n });
          await notify(tx, 'inspection_done', { users: [link.created_by], orderId: order.id });
          return { finished: true, photos: n };
        });
      },
    },
  ];
}

