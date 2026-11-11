// «Ваш эксперт» и «Принять» (2.465, схема 5 экранов — решение Дамира 31.10/02.11.2026; лента — решение 10.11.2026: эксперт
// берёт дело сам или его назначает диспетчер, заказчик эксперта не выбирает). У модуля с offer.accept: 'expert' заказчик,
// когда эксперт взял дело, видит карточку эксперта: имя, организация, документы досье (без номеров и копий), сколько дел
// сдано через платформу и в срок — и нажимает «Принять»: это согласие с условиями заказа (офертой) с этим экспертом.
// Эксперт и диспетчер видят, принял ли заказчик. Дело передали другому эксперту — новый принимается заново.
// «Принять» работу не останавливает: эксперт работает и до него (иначе срок дела зависел бы от того, когда заказчик зайдёт).
import { HttpError } from '../http/core.mjs';
import { LEVEL, executorSignOrg, isStaff, orderLevel, orderSides } from '../access/policy.mjs';
import { audit, uuidFrom } from './util.mjs';
import { notify } from '../notify/notify.mjs';
import { loadDossier } from '../dossier/dossier.mjs';
import { workStats } from '../matching/stats.mjs';

// Когда заказчик видит эксперта: дело взято и дальше. «Принять» — пока дело в работе или на проверке.
const SHOWN = ['in_work', 'review', 'done', 'closed'];
const ACCEPTABLE = ['in_work', 'review'];
// Документы досье, которые видит заказчик: образование и квалификация (без номеров, копий и аккредитаций в банках).
const CARD_KINDS = ['education', 'certificate', 'sro', 'policy', 'policy_org'];

const acceptOn = (registry, order) => registry.offer(order.module, order.service)?.accept === 'expert';

async function acceptRow(sql, order) {
  return order.executor_user_id
    ? sql.one`select to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, offer_version from expert_accepts
              where order_id = ${order.id} and executor_user_id = ${order.executor_user_id}`
    : null;
}

// Карточка эксперта заказчику (orders.get → my_expert); null — не заказчик, у модуля нет «Принять» или эксперта ещё нет.
export async function myExpertView(sql, registry, order, actor) {
  if (!acceptOn(registry, order) || !order.executor_user_id || !SHOWN.includes(order.status)) return null;
  if (!orderSides(actor, order).includes('customer') || order.executor_user_id === actor.id) return null;
  const id = order.executor_user_id;
  const user = await sql.one`select full_name from users where id = ${id}`;
  const org = await executorSignOrg(sql, id);
  const docs = (await loadDossier(sql, id)).filter((d) => CARD_KINDS.includes(d.kind)).map((d) => ({
    kind: d.kind, kind_name: d.kind_name, title: d.title, valid_until: d.valid_until, state: d.state,
    ...(d.kind.startsWith('policy') && d.amount_kop ? { amount_kop: d.amount_kop } : {}),
  }));
  const st = (await workStats(sql, [id])).get(id);
  const acc = await acceptRow(sql, order);
  return {
    executor_user_id: id,
    name: user?.full_name || 'Эксперт',
    org: org?.name ?? null,
    docs,
    done: st.done, on_time: st.on_time,
    accepted_at: acc?.at ?? null,
    can_accept: !acc && ACCEPTABLE.includes(order.status) && orderLevel(actor, order) >= LEVEL.write,
  };
}

// Принял ли заказчик эксперта — самому эксперту и служебным (orders.get → customer_accept).
export async function customerAcceptView(sql, registry, order, actor) {
  if (!acceptOn(registry, order) || !order.executor_user_id || !SHOWN.includes(order.status)) return null;
  if (!(isStaff(actor) || order.executor_user_id === actor.id)) return null;
  const acc = await acceptRow(sql, order);
  return { accepted_at: acc?.at ?? null };
}

export function expertAcceptOps() {
  return [
    {
      // Body: { executor_user_id } — эксперт, чью карточку заказчик видел: дело успели передать другому — «обновите».
      id: 'orders.expert.accept', method: 'POST', path: '/api/orders/:id/expert/accept', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler({ sql, actor, order, body, registry }) {
        if (!orderSides(actor, order).includes('customer')) throw new HttpError(403, 'forbidden', 'Принимает эксперта заказчик');
        const offer = registry.offer(order.module, order.service);
        if (offer?.accept !== 'expert') throw new HttpError(409, 'no_accept', 'В этой заявке принимать эксперта не нужно');
        const seen = uuidFrom(body?.executor_user_id, 'Эксперт не найден');
        return sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (!cur.executor_user_id || cur.executor_user_id !== seen) {
            throw new HttpError(409, 'stale', 'Эксперт по заявке сменился — обновите страницу');
          }
          if (cur.executor_user_id === actor.id) throw new HttpError(403, 'forbidden', 'Принимает эксперта заказчик');
          if (!ACCEPTABLE.includes(cur.status)) throw new HttpError(409, 'bad_status', 'Принять эксперта можно, пока дело в работе или на проверке');
          const [row] = await tx`insert into expert_accepts (order_id, executor_user_id, user_id, offer_version)
                                 values (${cur.id}, ${cur.executor_user_id}, ${actor.id}, ${offer.version})
                                 on conflict do nothing returning at`;
          if (!row) throw new HttpError(409, 'already', 'Вы уже приняли этого эксперта');
          await audit(tx, actor, 'order.expert.accept', 'order', cur.id, { executor: cur.executor_user_id, offer: offer.version });
          await notify(tx, 'expert_accepted', { users: [cur.executor_user_id], orderId: cur.id, actor });
          return { accepted_at: row.at };
        });
      },
    },
  ];
}
