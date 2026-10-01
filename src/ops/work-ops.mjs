// Работа по делу (задача 1.5): переписка по заявке и проверка результата до выдачи.
// Переписка — одна лента на заявку: заказчик, исполнитель, диспетчер. Имена авторов видят только служебные; остальные —
// сторону («заказчик», «исполнитель», «диспетчер»): заказчик не знает имени исполнителя (решение 01.10.2026, задача 1.4).
// Проверка результата — по списку правил модуля (src/modules/): по каждому правилу проверяющий ставит «в порядке» или
// «замечание» с пояснением. «Готово» — только когда все правила текущего круга в порядке (src/ops/order-ops.mjs).
import { HttpError } from '../http/core.mjs';
import { isStaff, messageSide, orderSides, seesReviewDetails } from '../access/policy.mjs';
import { FINAL } from '../orders/workflow.mjs';
import { audit, text } from './util.mjs';
import { notifyMessage } from '../notify/notify.mjs';

const MESSAGE_MAX = 4000;
const NOTE_MAX = 1000;

// Отметки текущего (или последнего) круга проверки по правилам услуги и итог.
export async function reviewState(sql, registry, order) {
  const rules = registry.checks(order.module, order.service);
  const marks = order.review_round > 0
    ? await sql`select check_id, verdict, note, at from result_checks where order_id = ${order.id} and round = ${order.review_round}`
    : [];
  const byId = new Map(marks.map((m) => [m.check_id, m]));
  const checks = rules.map((r) => {
    const m = byId.get(r.id);
    return { id: r.id, title: r.title, verdict: m?.verdict ?? null, note: m?.note ?? null, at: m?.at ?? null };
  });
  return {
    round: order.review_round,
    checks,
    summary: {
      total: checks.length,
      ok: checks.filter((c) => c.verdict === 'ok').length,
      issues: checks.filter((c) => c.verdict === 'issue').length,
      unchecked: checks.filter((c) => !c.verdict).length,
    },
  };
}

export function workOps() {
  return [
    {
      id: 'messages.list', method: 'GET', path: '/api/orders/:id/messages', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) {
        const staff = isStaff(actor);
        const rows = await sql`
          select m.id, m.author_id, m.side, m.body, m.at, u.full_name
          from order_messages m join users u on u.id = m.author_id
          where m.order_id = ${order.id} order by m.id limit 500`;
        return {
          messages: rows.map((m) => ({
            id: String(m.id), side: m.side, body: m.body, at: m.at, mine: m.author_id === actor.id,
            author_name: staff ? m.full_name : null,
          })),
          can_write: !!messageSide(actor, order) && !FINAL.includes(order.status),
        };
      },
    },
    {
      id: 'messages.post', method: 'POST', path: '/api/orders/:id/messages', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body, res }) {
        const side = messageSide(actor, order);
        if (!side) throw new HttpError(403, 'forbidden', 'Писать в переписку по этой заявке Вы не можете');
        if (FINAL.includes(order.status)) throw new HttpError(409, 'order_final', 'Заявка завершена — переписка закрыта');
        const msg = text(body?.body, 'Сообщение', MESSAGE_MAX);
        const row = await sql.tx(async (tx) => {
          const m = await tx.one`insert into order_messages (order_id, author_id, side, body)
                                 values (${order.id}, ${actor.id}, ${side}, ${msg}) returning *`;
          await audit(tx, actor, 'message.post', 'order', order.id, { message: String(m.id), side });
          await notifyMessage(tx, { actor, order, side });
          return m;
        });
        res.status(201);
        return { message: { id: String(row.id), side, body: row.body, at: row.at, mine: true, author_name: isStaff(actor) ? actor.full_name : null } };
      },
    },
    {
      // Проверка результата: служебные и исполнитель видят отметки по правилам; заказчик — только итог.
      id: 'review.get', method: 'GET', path: '/api/orders/:id/review', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        const st = await reviewState(sql, registry, order);
        const canMark = order.status === 'review' && orderSides(actor, order).includes('dispatcher');
        if (!seesReviewDetails(actor, order)) return { round: st.round, details: false, summary: st.summary, can_mark: false };
        return { ...st, details: true, can_mark: canMark };
      },
    },
    {
      // Отметка по одному правилу текущего круга проверки. Ставит диспетчер, пока заявка на проверке.
      id: 'review.mark', method: 'PUT', path: '/api/orders/:id/review/:check', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params, body, registry }) {
        if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
        const rule = registry.checks(order.module, order.service).find((c) => c.id === params.check);
        if (!rule) throw new HttpError(404, 'not_found', 'Такого правила проверки нет');
        const verdict = String(body?.verdict ?? '');
        if (!['ok', 'issue'].includes(verdict)) throw new HttpError(400, 'bad_input', 'Отметка: «в порядке» или «замечание»');
        const raw = body?.note == null ? '' : String(body.note).trim();
        if (raw.length > NOTE_MAX) throw new HttpError(400, 'bad_input', `Пояснение — не длиннее ${NOTE_MAX} символов`);
        if (verdict === 'issue' && !raw) throw new HttpError(400, 'note_required', 'Опишите замечание');
        const note = raw || null;
        const round = Number(body?.round);
        await sql.tx(async (tx) => {
          // Отметка относится к кругу, который проверяющий видел: если результат уже вернули или сдали заново — не ставится.
          const cur = await tx.one`select status, review_round from orders where id = ${order.id} for update`;
          if (cur.status !== 'review' || cur.review_round !== round) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          await tx`insert into result_checks (order_id, round, check_id, verdict, note, checked_by)
                   values (${order.id}, ${round}, ${rule.id}, ${verdict}, ${note}, ${actor.id})
                   on conflict (order_id, round, check_id)
                   do update set verdict = excluded.verdict, note = excluded.note, checked_by = excluded.checked_by, at = now()`;
          await audit(tx, actor, 'review.mark', 'order', order.id, { round, check: rule.id, verdict });
        });
        const fresh = await sql.one`select * from orders where id = ${order.id}`;
        return { ...(await reviewState(sql, registry, fresh)), details: true, can_mark: true };
      },
    },
  ];
}
