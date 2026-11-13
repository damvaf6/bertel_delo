// Товароведческая экспертиза (2.480): гарантия на дату обнаружения недостатка — подсказкой в деле всем, кто видит заявку
// (заказчику, диспетчеру, эксперту). Дата покупки — из «Когда и где куплен, цена по чеку» (`purchaseOf` из 2.61),
// срок — «Гарантийный срок, месяцев», дата обнаружения — «Когда обнаружен недостаток». Только факты по датам: выводов о
// праве (вернут ли деньги) не делаем — это не дело платформы и не дело эксперта.
import { purchaseOf } from '../ai/report-checks.mjs';
import { todayMsk } from './workflow.mjs';

const ru = (iso) => iso.split('-').reverse().join('.');
const fromRu = (s) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s ?? '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const valid = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso; };

// Последний день гарантии: покупка 12.03.2026 + 12 месяцев → 12.03.2027 (как в ст. 191–192 ГК: в то же число;
// нет такого числа — последний день месяца).
export function warrantyEnd(bought, months) {
  const [y, m, d] = bought.split('-').map(Number);
  const total = (m - 1) + months;
  const yy = y + Math.floor(total / 12);
  const mm = total % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(yy, mm, Math.min(d, last))).toISOString().slice(0, 10);
}

// { bought, months, end, found, state: 'in' | 'out' | 'none' | 'before' | 'future' } или null, когда считать не из чего.
export function warrantyOf(fields = {}, today = todayMsk()) {
  const bought = purchaseOf(fields.purchase).date;
  const months = fields.warranty_months === undefined || fields.warranty_months === '' || fields.warranty_months === null
    ? null : Number(fields.warranty_months);
  const found = fromRu(fields.found_date);
  if (!bought || !valid(bought) || months === null || !Number.isInteger(months) || months < 0) return null;
  const at = found && valid(found) ? found : null;
  if (months === 0) return { bought, months, end: null, found: at, state: 'none' };
  const end = warrantyEnd(bought, months);
  if (!at) return { bought, months, end, found: null, state: today <= end ? 'in' : 'out' };
  if (at < bought) return { bought, months, end, found: at, state: 'before' };
  if (at > today) return { bought, months, end, found: at, state: 'future' };
  return { bought, months, end, found: at, state: at <= end ? 'in' : 'out' };
}

export function warrantyNotices(serviceId, fields = {}, today = todayMsk()) {
  if (serviceId !== 'goods') return [];
  const w = warrantyOf(fields, today);
  if (!w) return [];
  const term = `гарантия ${w.months} мес. с ${ru(w.bought)} — до ${w.end ? ru(w.end) : ''}`;
  const text = {
    none: `Гарантии на товар нет (куплен ${ru(w.bought)}).${w.found ? ` Недостаток обнаружен ${ru(w.found)}.` : ''}`,
    before: `Дата обнаружения недостатка (${ru(w.found ?? '')}) раньше даты покупки (${ru(w.bought)}) — проверьте даты в заявке.`,
    future: `Дата обнаружения недостатка (${ru(w.found ?? '')}) ещё не наступила — проверьте даты в заявке.`,
    in: w.found ? `Недостаток обнаружен ${ru(w.found)} — в гарантийный срок (${term}).` : `Гарантийный срок не кончился: ${term}.`,
    out: w.found ? `Недостаток обнаружен ${ru(w.found)} — после гарантийного срока (${term}).` : `Гарантийный срок кончился: ${term}.`,
  }[w.state];
  return [{ id: `warranty_${w.state}`, text }];
}
