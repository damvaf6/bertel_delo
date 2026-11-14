// Проверка в реестре залогов (задача 2.491, «Оценка транспорта»). Эксперт дела, пока дело в работе, отмечает дату проверки
// в реестре уведомлений о залоге движимого имущества и итог: залога нет или есть — номер уведомления и залогодержатель.
// Строкой — в раздел «7. Описание объекта» черновика (src/orders/pledge.mjs); ИИ-проверка сверяет отчёт с отметкой
// (pledge_match). Видят все, кто видит дело; пишет только эксперт дела.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { NOTICE_NO_MAX, PLEDGEE_MAX, RESULTS, loadPledge, pledgeLine } from '../orders/pledge.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { audit, text } from './util.mjs';

// Проверка — не раньше года назад (оценка по старой проверке всё равно потребует новой).
const BACK_DAYS = 365;

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
const specOf = (registry, order) => (order.module ? registry.pledge(order.module, order.service) : false);
const canWrite = (spec, actor, order) => spec && order.status === 'in_work' && isExecutor(actor, order);

function writable(spec, actor, order) {
  if (!spec) throw new HttpError(409, 'not_supported', 'Проверка в реестре залогов — только для оценки транспорта');
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Проверку в реестре залогов отмечает эксперт дела');
  if (order.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Проверку в реестре залогов отмечают, пока дело в работе');
}

export async function pledgeView(sql, registry, actor, order) {
  const spec = specOf(registry, order);
  if (!spec) return { available: false };
  const p = await loadPledge(sql, order.id);
  return {
    available: true, can_write: canWrite(spec, actor, order),
    results: Object.entries(RESULTS).map(([id, name]) => ({ id, name })),
    notice_max: NOTICE_NO_MAX, pledgee_max: PLEDGEE_MAX,
    // Для подсказки: VIN из заявки — по нему ищут в реестре.
    vin: String(order.fields?.vin ?? '') || null,
    check: p ? { checked_on: p.checked_on, result: p.result, notice_no: p.notice_no || null, pledgee: p.pledgee || null } : null,
    line: pledgeLine(p),
  };
}

// Тело: { checked_on: 'ГГГГ-ММ-ДД', result: 'none'|'found', notice_no, pledgee }.
function readBody(body) {
  const on = String(body?.checked_on ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00Z`)) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) {
    throw new HttpError(400, 'bad_input', 'Укажите дату проверки в реестре');
  }
  if (on > todayMsk()) throw new HttpError(400, 'bad_input', 'Дата проверки — не позже сегодняшней');
  if (on < addDays(todayMsk(), -BACK_DAYS)) throw new HttpError(400, 'bad_input', 'Дата проверки — не раньше года назад; проверьте машину в реестре заново');
  const result = String(body?.result ?? '');
  if (!RESULTS[result]) throw new HttpError(400, 'bad_input', 'Выберите итог проверки: залога нет или залог есть');
  if (result === 'none') return { on, result, notice: '', pledgee: '' };
  return { on, result, notice: text(body?.notice_no, 'Номер уведомления о залоге', NOTICE_NO_MAX), pledgee: text(body?.pledgee, 'Залогодержатель', PLEDGEE_MAX) };
}

export function pledgeOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  return [
    {
      id: 'pledge.get', method: 'GET', path: '/api/orders/:id/pledge', auth: 'user', access,
      handler: ({ sql, registry, actor, order }) => pledgeView(sql, registry, actor, order),
    },
    {
      id: 'pledge.save', method: 'PUT', path: '/api/orders/:id/pledge', auth: 'user', access,
      async handler({ sql, registry, actor, order, body }) {
        writable(specOf(registry, order), actor, order);
        const v = readBody(body);
        await sql.tx(async (tx) => {
          await tx`insert into pledge_checks (order_id, checked_on, result, notice_no, pledgee, created_by)
                   values (${order.id}, ${v.on}, ${v.result}, ${v.notice}, ${v.pledgee}, ${actor.id})
                   on conflict (order_id) do update set checked_on = excluded.checked_on, result = excluded.result,
                     notice_no = excluded.notice_no, pledgee = excluded.pledgee, updated_at = now()`;
          await audit(tx, actor, 'pledge.save', 'order', order.id, { result: v.result });
        });
        return pledgeView(sql, registry, actor, order);
      },
    },
    {
      id: 'pledge.delete', method: 'DELETE', path: '/api/orders/:id/pledge', auth: 'user', access,
      async handler({ sql, registry, actor, order }) {
        writable(specOf(registry, order), actor, order);
        await sql.tx(async (tx) => {
          await tx`delete from pledge_checks where order_id = ${order.id}`;
          await audit(tx, actor, 'pledge.delete', 'order', order.id, {});
        });
        return pledgeView(sql, registry, actor, order);
      },
    },
  ];
}
