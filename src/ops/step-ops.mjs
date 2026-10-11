// Шаги заказа (задача 2а.6, задача штаба 3f617197): передача оригинала (курьер / встреча), подпись у нотариуса, файл
// нотариуса в кабинет, выдача бумаги (самовывоз / курьер / почта). Какие шаги у услуги — описание модуля (steps,
// src/modules/index.mjs). Отмечает исполнитель дела или диспетчер (по шагу — кто именно), заказчик видит, что сделано и когда,
// без имён. Шаги «до сдачи» нужны, чтобы сдать перевод на проверку (missingSteps, вызов из шага статуса в order-ops.mjs).
// Файл нотариуса — свой файл результата переводчика: после проверки заказчик видит его с пометкой «Файл нотариуса».
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { customersOf, notify } from '../notify/notify.mjs';
import { audit, uuidFrom } from './util.mjs';

// Пока заявка не закрыта — шаги можно отмечать; «до сдачи» — только пока результат не сдан.
const OPEN = ['awaiting_executor', 'in_work', 'review', 'done'];
const BEFORE_REVIEW = ['awaiting_executor', 'in_work'];
const NOTE_MAX = 300;

async function marks(sql, orderId) {
  const rows = await sql`select step, done_at, note, document_id from order_steps where order_id = ${orderId}`;
  return new Map(rows.map((r) => [r.step, r]));
}

// Шаги «до сдачи на проверку», ещё не отмеченные: названия (пусто — сдавать можно).
export async function missingSteps(tx, registry, order) {
  const need = registry.steps(order.module, order.service, order.fields).filter((s) => s.before === 'review');
  if (!need.length) return [];
  const done = await marks(tx, order.id);
  return need.filter((s) => !done.has(s.id)).map((s) => s.title);
}

// Файлы результата, отмеченные шагом (файл нотариуса): document_id → название шага.
export async function stepFiles(sql, registry, order) {
  const files = registry.steps(order.module, order.service, order.fields).filter((s) => s.file);
  if (!files.length) return new Map();
  const rows = await sql`select step, document_id from order_steps where order_id = ${order.id} and document_id is not null`;
  return new Map(rows.filter((r) => files.some((s) => s.id === r.step)).map((r) => [r.document_id, 'Файл нотариуса']));
}

const canTouch = (step, sides, status) => step.by.some((b) => sides.includes(b))
  && (step.before === 'review' ? BEFORE_REVIEW : OPEN).includes(status);

async function view(sql, registry, actor, order) {
  const steps = registry.steps(order.module, order.service, order.fields);
  if (!steps.length) return { available: false };
  const sides = orderSides(actor, order);
  const done = await marks(sql, order.id);
  const mine = sides.includes('executor');
  // Исполнителю для шага с файлом — свои файлы результата в деле.
  const files = mine && steps.some((s) => s.file)
    ? await sql`select id, filename from documents where order_id = ${order.id} and kind = 'result' and deleted_at is null
                and uploaded_by = ${actor.id} order by created_at` : [];
  return {
    available: true,
    status: order.status,
    steps: steps.map((s) => {
      const m = done.get(s.id);
      const can = canTouch(s, sides, order.status);
      return {
        id: s.id, title: s.title, hint: s.hint, before_review: s.before === 'review', file: s.file,
        done: !!m, done_at: m?.done_at ?? null, note: m?.note || null,
        can_mark: !m && can, can_undo: !!m && can, note_label: s.note,
      };
    }),
    ...(mine ? { files: files.map((f) => ({ id: f.id, filename: f.filename })) } : {}),
  };
}

function stepOf(registry, order, id) {
  const s = registry.steps(order.module, order.service, order.fields).find((x) => x.id === String(id ?? ''));
  if (!s) throw new HttpError(404, 'not_found', 'Такого шага у заказа нет');
  return s;
}

function touchable(actor, order, step) {
  const sides = orderSides(actor, order);
  if (!step.by.some((b) => sides.includes(b))) {
    throw new HttpError(403, 'forbidden', step.by.includes('dispatcher') ? 'Шаг отмечает исполнитель или платформа' : 'Шаг отмечает исполнитель дела');
  }
  if (!canTouch(step, sides, order.status)) {
    throw new HttpError(409, 'status_changed', step.before === 'review' ? 'Перевод уже сдан — этот шаг больше не меняется' : 'Заявка закрыта — шаги не меняются');
  }
}

export function stepOps() {
  return [
    {
      id: 'steps.list', method: 'GET', path: '/api/orders/:id/steps', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) { return view(sql, registry, actor, order); },
    },
    {
      // Отметить шаг: note — пометка (трек-номер, нотариус); для шага с файлом — document_id своего файла результата.
      id: 'steps.mark', method: 'POST', path: '/api/orders/:id/steps/:step', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, params, body }) {
        const step = stepOf(registry, order, params.step);
        touchable(actor, order, step);
        const note = String(body?.note ?? '').trim();
        if (note.length > NOTE_MAX) throw new HttpError(400, 'bad_input', `Пометка — до ${NOTE_MAX} символов`);
        let docId = null;
        if (step.file) {
          docId = uuidFrom(body?.document_id, 'Выберите файл нотариуса среди своих файлов результата');
          const d = await sql.one`select 1 from documents where id = ${docId} and order_id = ${order.id} and kind = 'result'
                                  and deleted_at is null and uploaded_by = ${order.executor_user_id} and uploaded_by = ${actor.id}`;
          if (!d) throw new HttpError(400, 'bad_document', 'Выберите файл нотариуса среди своих файлов результата');
        }
        await sql.tx(async (tx) => {
          const ins = await tx`insert into order_steps (order_id, step, done_by, note, document_id)
                               values (${order.id}, ${step.id}, ${actor.id}, ${note}, ${docId})
                               on conflict (order_id, step) do nothing returning step`;
          if (!ins.length) throw new HttpError(409, 'already', 'Шаг уже отмечен — обновите страницу');
          await audit(tx, actor, 'order.step', 'order', order.id, { step: step.id });
          // Заказчику — что шаг сделан; исполнителю — если отметила платформа (например, оригинал получен).
          await notify(tx, 'order_step', { users: await customersOf(tx, order), orderId: order.id, actor });
          if (order.executor_user_id && order.executor_user_id !== actor.id) {
            await notify(tx, 'order_step_executor', { users: [order.executor_user_id], orderId: order.id, actor });
          }
        });
        return view(sql, registry, actor, order);
      },
    },
    {
      id: 'steps.undo', method: 'DELETE', path: '/api/orders/:id/steps/:step', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, params }) {
        const step = stepOf(registry, order, params.step);
        touchable(actor, order, step);
        await sql.tx(async (tx) => {
          const del = await tx`delete from order_steps where order_id = ${order.id} and step = ${step.id} returning step`;
          if (!del.length) throw new HttpError(409, 'not_done', 'Шаг не отмечен — обновите страницу');
          await audit(tx, actor, 'order.step_undo', 'order', order.id, { step: step.id });
        });
        return view(sql, registry, actor, order);
      },
    },
  ];
}
