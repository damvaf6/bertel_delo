// Лента заказов эксперта (2.468, решение Дамира 10.11.2026: «эксперт сам берёт заказ — заказчик эксперта не выбирает»).
// Заказ попадает в ленту, когда он в подборе, у него есть цена и он оплачен, а диспетчер ещё никому его не предложил.
// Видят его только те, кому диспетчер мог бы его предложить (candidatesFor: допуск на услугу, принимает дела, досье в
// порядке, не своё дело), и только в своих регионах. До того как взять, эксперт видит услугу, выбранные из списка
// поля заявки (вид объекта, цель, регион — без адреса, имён и свободного текста), срок и свою выплату.
// «Взять заказ» — первый, кто нажал: дело сразу в работе у него, остальным пропадает из ленты; заказчику — «исполнитель
// принял заявку», диспетчеру — «эксперт взял заказ из ленты». Подбор диспетчером остаётся как был.
import { HttpError } from '../http/core.mjs';
import { candidatesFor } from './match-ops.mjs';
import { audit, uuidFrom } from './util.mjs';
import { notify, customersOf, dispatchers } from '../notify/notify.mjs';
import { orderRef } from '../notify/registry.mjs';
import { orderSplit } from '../money/money.mjs';
import { todayMsk } from '../orders/workflow.mjs';

const FEED_LIMIT = 50;

// Заказы, которые сейчас в ленте вообще (без отбора по эксперту), — новые первыми.
async function feedOrders(sql, { id = null } = {}) {
  const rows = id
    ? await sql`select * from orders where id = ${id} for update`
    : await sql`select * from orders where status = 'matching' and price_kop is not null and paid_at is not null
                  and executor_user_id is null and offer_org_id is null
                order by paid_at desc limit ${FEED_LIMIT}`;
  return rows.filter((o) => o.status === 'matching' && o.price_kop && o.paid_at && !o.executor_user_id && !o.offer_org_id);
}

// Регионы эксперта; у заказа регион — поле region (если оно есть в услуге). Без регионов в профиле — все.
function inRegions(order, regions) {
  const r = order.fields?.region;
  return !r || !regions?.length || regions.includes(r);
}

// Подходит ли заказ эксперту: тот же отбор, что у диспетчера в подборе, и регион.
async function eligible(sql, order, userId, regions, registry) {
  if (!inRegions(order, regions)) return null;
  return (await candidatesFor(sql, order, registry)).find((c) => c.user_id === userId) ?? null;
}

// Строка ленты: без адреса, имён, телефонов и свободного текста — только выбранное из списков.
function feedItem(order, registry, cand) {
  const svc = registry.service(order.module, order.service);
  const facts = [];
  for (const f of svc?.fields ?? []) {
    if (f.type !== 'select') continue;
    const v = order.fields?.[f.id];
    const opt = f.options?.find((o) => o.id === v);
    if (opt) facts.push({ label: f.label, value: opt.name });
  }
  const days = order.deadline ? Math.round((new Date(order.deadline) - new Date(todayMsk())) / 86400000) : null;
  return {
    id: order.id, ref: orderRef(order.id),
    module: order.module, service: order.service, service_name: svc?.service.name ?? order.service,
    facts, deadline: order.deadline ?? null,
    days_left: days, express: !!order.express,
    payout_kop: orderSplit(order).payoutKop,
    // Заказ для банка (2.453): нет аккредитации в этом банке — предупредить до того, как взять.
    bank: cand?.bank === undefined ? null : { accredited: !!cand.bank },
    since: order.paid_at,
  };
}

export function feedOps() {
  return [
    {
      // Лента заказов: что эксперт может взять сам. Не специалист — пусто.
      id: 'specialist.feed', method: 'GET', path: '/api/specialist/feed', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        const sp = await sql.one`select active, regions, away_from, away_until from specialists where user_id = ${actor.id}`;
        if (!sp) return { feed: [], specialist: false };
        const items = [];
        for (const o of await feedOrders(sql)) {
          const cand = await eligible(sql, o, actor.id, sp.regions, registry);
          if (cand) items.push(feedItem(o, registry, cand));
        }
        // Почему лента пустая: не принимает дела — сказать прямо.
        return { feed: items, specialist: true, active: sp.active };
      },
    },
    {
      // Взять заказ из ленты: первый нажавший получает дело в работу. Заказа нет в ленте эксперта (взял другой, снят
      // диспетчером, чужой, нет допуска) — «не найдено»: по ответу не узнать, чей это заказ.
      id: 'specialist.feed.take', method: 'POST', path: '/api/specialist/feed/:id/take', auth: 'user', access: 'self',
      async handler({ sql, actor, params, registry }) {
        const orderId = uuidFrom(params.id, 'Заказ не найден');
        const gone = () => new HttpError(404, 'not_found', 'Заказа уже нет в ленте: его взял другой эксперт или он снят. Обновите ленту');
        const order = await sql.tx(async (tx) => {
          const sp = await tx.one`select regions from specialists where user_id = ${actor.id}`;
          if (!sp) throw gone();
          const [cur] = await feedOrders(tx, { id: orderId });
          if (!cur) throw gone();
          const cand = await eligible(tx, cur, actor.id, sp.regions, registry);
          if (!cand) throw gone();
          await tx`insert into order_offers (order_id, specialist_id, org_id, score, offered_by, outcome, outcome_at, reason)
                   values (${cur.id}, ${actor.id}, null, ${JSON.stringify({ ...cand.score, feed: true })}, ${actor.id}, 'accepted', now(), 'Взял из ленты заказов')`;
          const o = await tx.one`update orders set status = 'in_work', executor_user_id = ${actor.id}, updated_at = now()
                                 where id = ${cur.id} returning *`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side, reason)
                   values (${cur.id}, 'matching', 'in_work', ${actor.id}, 'executor', 'Взял из ленты заказов')`;
          await audit(tx, actor, 'order.feed.take', 'order', cur.id, { score: cand.score.total });
          await notify(tx, 'accepted', { users: await customersOf(tx, cur), orderId: cur.id, actor });
          await notify(tx, 'feed_taken', { users: await dispatchers(tx), orderId: cur.id, actor });
          return o;
        });
        return { order: { id: order.id, status: order.status, executor_user_id: order.executor_user_id } };
      },
    },
  ];
}
