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
import { heirObjects, inheritanceOf } from '../orders/inheritance.mjs';
import { shareOf } from '../orders/share.mjs';
import { dduQuarter } from '../analogs/analogs.mjs';

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
  const share = shareFeed(order);
  const premises = premisesFeed(order);
  const house = houseFeed(order);
  const ddu = dduFeed(order);
  const facts = [];
  for (const f of svc?.fields ?? []) {
    if (f.type !== 'select') continue;
    if (share && ['share_method', 'share_use'].includes(f.id)) continue; // способ и порядок — в строке о доле (2.516)
    if (PREMISES_SELECTS.includes(f.id)) continue; // назначение, аренда и вход — в строке о нежилом (2.526)
    if (HOUSE_SELECTS.includes(f.id)) continue; // участок, газ, стены, зима — в строке о доме (2.536)
    if (f.id === 'ddu_finish') continue; // отделка по договору — в строке о ДДУ (2.546)
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
    heir: heirFeed(order),
    share,
    premises,
    house,
    ddu,
    since: order.paid_at,
  };
}

// Прогон 2.509: оценка для наследства — до того как взять, эксперт видит, что оценка на прошлую дату (сколько месяцев
// назад — без самой даты: это день смерти человека) и сколько объектов в составе наследства. Это меняет работу: нужен
// архив объявлений на ту дату, а объектов может быть несколько за одну цену.
export function heirFeed(order, today = todayMsk()) {
  const f = order.fields ?? {};
  if (f.purpose !== 'inheritance') return null;
  const h = inheritanceOf(f, today);
  let months = null;
  if (h?.state === 'ok') {
    const [y1, m1, d1] = h.day.split('-').map(Number);
    const [y2, m2, d2] = today.split('-').map(Number);
    months = Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
  }
  return { months, objects: heirObjects(f).length + 1 };
}

// 2.516: оценка доли — до того как взять, эксперт видит размер доли и способ: рыночная стоимость доли (скидка на долю с
// источником) или часть стоимости целого (без скидки); способ не указан — уточнять (для суда — по определению); порядок
// пользования — из списка. Размер — только дробью (это не личные сведения); иначе — «не указан».
export function shareFeed(order) {
  const f = order.fields ?? {};
  if (order.service !== 'realty' || f.object_type !== 'share') return null;
  const s = shareOf(f.share_size);
  const method = ['market', 'pro_rata'].includes(f.share_method) ? f.share_method : null;
  const use = ['agreement', 'court', 'none'].includes(f.share_use) ? f.share_use : null;
  return { size: s ? `${s.a}/${s.b}` : null, method, use, court: ['court', 'division'].includes(f.purpose) };
}

// 2.526: нежилое помещение — до того как взять, эксперт видит назначение, сдаётся ли помещение (от этого зависит доходный
// подход и нужен ли договор аренды) и вход. Только выбранное из списков; сумму аренды лента не показывает — лишь указана
// ли она. У не нежилого (или не оценки недвижимости) — ничего: случайно заполненные поля нежилого в ленту не идут.
const PREMISES_SELECTS = ['premises_use', 'lease', 'entrance'];
export function premisesFeed(order) {
  const f = order.fields ?? {};
  if (order.service !== 'realty' || f.object_type !== 'commercial') return null;
  const pick = (v, ids) => (ids.includes(v) ? v : null);
  const lease = pick(f.lease, ['full', 'part', 'no']);
  const rent = Number(f.lease_rent);
  return {
    use: pick(f.premises_use, ['office', 'retail', 'warehouse', 'free']),
    lease,
    rent: lease === 'full' || lease === 'part' ? Number.isFinite(rent) && rent > 0 : null,
    entrance: pick(f.entrance, ['street', 'common']),
  };
}

// 2.536: жилой дом — до того как взять, эксперт видит, что оценивать (дом с участком, с правом аренды участка или только
// дом), площадь участка в сотках, газ, материал стен и летний ли дом. Только выбранное из списков и площадь числом;
// кадастрового номера участка лента не показывает — по нему находится адрес. У не дома — ничего.
const HOUSE_SELECTS = ['house_walls', 'house_land', 'house_gas', 'house_winter'];
export function houseFeed(order) {
  const f = order.fields ?? {};
  if (order.service !== 'realty' || f.object_type !== 'house') return null;
  const pick = (v, ids) => (ids.includes(v) ? v : null);
  const area = Number(f.land_area);
  const land = pick(f.house_land, ['own', 'lease', 'none']);
  return {
    land,
    area: land !== 'none' && Number.isFinite(area) && area > 0 ? Math.round(area * 100) / 100 : null,
    gas: pick(f.house_gas, ['main', 'tank', 'none']),
    walls: pick(f.house_walls, ['brick', 'wood', 'frame', 'other']),
    winter: pick(f.house_winter, ['yes', 'no']),
  };
}

// 2.546: квартира в новостройке (права по ДДУ) — до того как взять, эксперт видит срок сдачи (квартал и год; из даты —
// её квартал: сама дата договора не нужна), прошёл ли он (тогда, возможно, дом уже введён и оценивается квартира),
// проектную площадь и отделку по договору. Номер ДДУ, застройщика, ЖК и условный номер лента не показывает — по ним
// находится адрес. Срок, записанный не датой и не кварталом, — «не указан». У не ДДУ — ничего.
export function dduFeed(order, today = todayMsk()) {
  const f = order.fields ?? {};
  if (order.service !== 'realty' || f.object_type !== 'ddu') return null;
  const q = dduQuarter(f.ddu_handover);
  const [y, m] = today.split('-').map(Number);
  const now = y * 4 + Math.floor((m - 1) / 3);
  const area = Number(f.ddu_area);
  return {
    due: q === null ? null : `${['I', 'II', 'III', 'IV'][q % 4]} кв. ${Math.floor(q / 4)}`,
    past: q === null ? null : q < now,
    area: Number.isFinite(area) && area > 0 ? Math.round(area * 10) / 10 : null,
    finish: ['none', 'white', 'full'].includes(f.ddu_finish) ? f.ddu_finish : null,
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
