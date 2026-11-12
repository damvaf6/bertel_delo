// Сверка с актом и расчётом страховой (задача 2.475, «Ущерб автомобилю после ДТП»). Эксперт дела, пока дело в работе,
// вносит детали из акта осмотра страховой, её сумму (с учётом износа или без) и свою сумму на той же основе; программа
// сравнивает с таблицей повреждённых деталей дела — совпадает, добавлено, исключено — и считает разницу
// (src/orders/insurer.mjs). Блок — в раздел «Исследование повреждений» черновика и оттуда в Word. Видят все, кто видит
// дело; пишет только эксперт дела. Есть там, где есть таблица повреждённых деталей (parts в модуле).
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { loadParts } from '../orders/parts.mjs';
import {
  BASIS_MAX, INS_PARTS_MAX, INS_PART_MAX, WEAR, compareInsurer, insurerBlock, insurerLine, insurerParts, loadInsurer, parseRub,
} from '../orders/insurer.mjs';
import { audit } from './util.mjs';

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
const canWrite = (spec, actor, order) => !!spec && order.status === 'in_work' && isExecutor(actor, order);
const specOf = (registry, order) => (order.module ? registry.parts(order.module, order.service) : null);

function writable(spec, actor, order) {
  if (!spec) throw new HttpError(409, 'not_supported', 'Сверка с расчётом страховой — только для ущерба автомобилю после ДТП');
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Сверку с расчётом страховой ведёт эксперт дела');
  if (order.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Сверку с расчётом страховой правят, пока дело в работе');
}

export async function insurerView(sql, registry, actor, order) {
  const spec = specOf(registry, order);
  if (!spec) return { available: false };
  const [calc, parts] = await Promise.all([loadInsurer(sql, order.id), loadParts(sql, order.id)]);
  const base = { available: true, can_write: canWrite(spec, actor, order), wear: WEAR, basis_max: BASIS_MAX, part_max: INS_PART_MAX, max: INS_PARTS_MAX, our_parts: parts.length };
  if (!calc) return { ...base, calc: null, block: null };
  const ours = parts.map((p) => p.part);
  const cmp = compareInsurer(calc, ours);
  return {
    ...base,
    calc: { basis: calc.basis, wear: calc.wear, insurer_kop: Number(calc.insurer_kop), own_kop: calc.own_kop == null ? null : Number(calc.own_kop), parts: calc.parts },
    compare: cmp,
    line: insurerLine(calc, cmp),
    block: insurerBlock(calc, ours),
  };
}

// Тело: { basis, wear: 'with'|'without', insurer: «123 456,78», own: сумма или пусто, parts: «деталь\nдеталь» или список }.
function readBody(body) {
  const basis = String(body?.basis ?? '').trim();
  if (basis.length > BASIS_MAX) throw new HttpError(400, 'bad_input', `Поле «Акт и расчёт страховой»: не больше ${BASIS_MAX} символов`);
  const wear = String(body?.wear ?? '');
  if (!WEAR[wear]) throw new HttpError(400, 'bad_input', 'Выберите, с учётом износа сумма страховой или без');
  const insurer = parseRub(body?.insurer);
  if (insurer === null) throw new HttpError(400, 'bad_input', 'Сумма страховой — в рублях, например 84 500 или 84 500,50');
  const rawOwn = body?.own;
  const own = rawOwn === undefined || rawOwn === null || String(rawOwn).trim() === '' ? null : parseRub(rawOwn);
  if (own === null && !(rawOwn === undefined || rawOwn === null || String(rawOwn).trim() === '')) {
    throw new HttpError(400, 'bad_input', 'Сумма по Вашему расчёту — в рублях, например 112 300; не посчитали — оставьте пустой');
  }
  const parts = insurerParts(body?.parts);
  if (parts.length > INS_PARTS_MAX) throw new HttpError(400, 'bad_input', `Деталей страховой — не больше ${INS_PARTS_MAX}`);
  const long = parts.find((p) => p.length > INS_PART_MAX);
  if (long) throw new HttpError(400, 'bad_input', `Название детали длиннее ${INS_PART_MAX} символов: «${long.slice(0, 40)}…»`);
  return { basis, wear, insurer, own, parts };
}

export function insurerOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  return [
    {
      id: 'insurer.get', method: 'GET', path: '/api/orders/:id/insurer', auth: 'user', access,
      handler: ({ sql, registry, actor, order }) => insurerView(sql, registry, actor, order),
    },
    {
      id: 'insurer.save', method: 'PUT', path: '/api/orders/:id/insurer', auth: 'user', access,
      async handler({ sql, registry, actor, order, body }) {
        writable(specOf(registry, order), actor, order);
        const v = readBody(body);
        await sql.tx(async (tx) => {
          await tx`insert into insurer_calcs (order_id, basis, wear, insurer_kop, own_kop, parts, created_by)
                   values (${order.id}, ${v.basis}, ${v.wear}, ${v.insurer}, ${v.own}, ${v.parts}, ${actor.id})
                   on conflict (order_id) do update set basis = excluded.basis, wear = excluded.wear, insurer_kop = excluded.insurer_kop,
                     own_kop = excluded.own_kop, parts = excluded.parts, updated_at = now()`;
          await audit(tx, actor, 'insurer.save', 'order', order.id, { parts: v.parts.length });
        });
        return insurerView(sql, registry, actor, order);
      },
    },
    {
      id: 'insurer.delete', method: 'DELETE', path: '/api/orders/:id/insurer', auth: 'user', access,
      async handler({ sql, registry, actor, order }) {
        writable(specOf(registry, order), actor, order);
        await sql.tx(async (tx) => {
          await tx`delete from insurer_calcs where order_id = ${order.id}`;
          await audit(tx, actor, 'insurer.delete', 'order', order.id, {});
        });
        return insurerView(sql, registry, actor, order);
      },
    },
  ];
}
