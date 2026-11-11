// Отзыв заказчика (2.467, схема 5 экранов — решение Дамира 31.10/02.11.2026, экран 5): после выдачи результата заказчик
// ставит оценку 1–5 и пишет пару слов. Видят диспетчер (в заявке и в карточке эксперта) и руководитель организации эксперта
// (ЦНЭР — в карточке эксперта); средняя оценка от трёх отзывов идёт в «качество» подбора (src/matching/score.mjs).
// Позже (схема): отзывы на витрине и ответ эксперта — поэтому самому эксперту отзыв пока не показывается.
// Один отзыв на заявку, об эксперте, который сдал результат; исправить нельзя (оценка — для подбора, не для переписки).
import { HttpError } from '../http/core.mjs';
import { LEVEL, isStaff, orderLevel, orderSides } from '../access/policy.mjs';
import { audit } from './util.mjs';

const OPEN = ['done', 'closed'];
export const REVIEW_TEXT_MAX = 500;


// Отзыв в заявке (orders.get → review): заказчику (mine) — свой отзыв или «можно оставить», служебным — отзыв или пусто;
// остальным — null.
export async function reviewView(sql, registry, order, actor) {
  if (!registry.review(order.module) || !order.executor_user_id || !OPEN.includes(order.status)) return null;
  const customer = orderSides(actor, order).includes('customer') && order.executor_user_id !== actor.id;
  if (!customer && !isStaff(actor)) return null;
  const r = await sql.one`select rating, text, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from order_reviews where order_id = ${order.id}`;
  return {
    mine: customer,
    rating: r?.rating ?? null, text: r?.text ?? null, at: r?.at ?? null,
    can_review: customer && !r && orderLevel(actor, order) >= LEVEL.write,
  };
}

// Отзывы об эксперте — в его карточку (specialists.card → reviews): средняя, сколько, последние 10 с номером заявки.
export async function expertReviews(sql, userId, orderRef) {
  const sum = await sql.one`select count(*)::int as n, round(avg(rating), 1)::float8 as avg from order_reviews where executor_user_id = ${userId}`;
  const last = await sql`
    select order_id, rating, text, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from order_reviews
    where executor_user_id = ${userId} order by at desc limit 10`;
  return { n: sum.n, avg: sum.avg, last: last.map((r) => ({ order_ref: orderRef(r.order_id), rating: r.rating, text: r.text, at: r.at })) };
}

export function reviewOps() {
  return [
    {
      // Body: { rating: 1..5, text? } — оценка и пара слов (до 500 знаков).
      id: 'orders.review', method: 'POST', path: '/api/orders/:id/review', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler({ sql, actor, order, body, registry }) {
        if (!orderSides(actor, order).includes('customer') || order.executor_user_id === actor.id) {
          throw new HttpError(403, 'forbidden', 'Отзыв оставляет заказчик');
        }
        if (!registry.review(order.module)) throw new HttpError(409, 'no_review', 'В этой заявке отзыв не предусмотрен');
        const rating = body?.rating;
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'bad_rating', 'Поставьте оценку от 1 до 5');
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (text.length > REVIEW_TEXT_MAX) throw new HttpError(400, 'too_long', `Отзыв — не длиннее ${REVIEW_TEXT_MAX} знаков`);
        return sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (!OPEN.includes(cur.status) || !cur.executor_user_id) {
            throw new HttpError(409, 'bad_status', 'Отзыв можно оставить, когда результат выдан');
          }
          const [row] = await tx`insert into order_reviews (order_id, executor_user_id, user_id, rating, text)
                                 values (${cur.id}, ${cur.executor_user_id}, ${actor.id}, ${rating}, ${text || null})
                                 on conflict do nothing returning to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`;
          if (!row) throw new HttpError(409, 'already', 'Вы уже оставили отзыв');
          await audit(tx, actor, 'order.review', 'order', cur.id, { executor: cur.executor_user_id, rating });
          return { rating, text: text || null, at: row.at };
        });
      },
    },
  ];
}
