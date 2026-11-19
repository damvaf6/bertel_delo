// Квартира в новостройке — права по ДДУ (2.539). Дом не введён в эксплуатацию: оценивается не квартира, а право требования
// по договору участия в долевом строительстве (214-ФЗ). Выписки ЕГРН на квартиру и кадастрового номера ещё нет, площадь —
// проектная, объект описывается по договору. Заказчик в заявке пишет номер и дату ДДУ, застройщика, ЖК и корпус, условный
// номер, проектную площадь, срок передачи и цену; здесь — подсказка в деле всем, кто видит заявку. О надёжности застройщика
// и законности договора не пишем — это вопрос юриста, не оценщика.
import { todayMsk } from './workflow.mjs';
import { headKey } from '../dossier/dossier.mjs';
import { isAssumptions } from './retro.mjs';

const FILLED = ['ddu_number', 'ddu_date', 'ddu_developer', 'ddu_complex', 'ddu_unit', 'ddu_area', 'ddu_handover', 'ddu_price'];

// «31.12.2027» → «2027-12-31»; квартал и прочий текст — null (срок не сравниваем).
export function dduDay(v) {
  const m = String(v ?? '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function dduNotices(serviceId, fields = {}, today = todayMsk()) {
  if (serviceId !== 'realty') return [];
  const has = (id) => fields[id] !== undefined && fields[id] !== null && String(fields[id]).trim() !== '';
  if (fields.object_type !== 'ddu') {
    return FILLED.some(has)
      ? [{ id: 'ddu_type', text: 'В заявке есть сведения о договоре участия в долевом строительстве (ДДУ), а оценивается не квартира в новостройке — проверьте «Что оцениваем».' }]
      : [];
  }
  const out = [{ id: 'ddu_right', text: 'Квартира в новостройке: оценивается право требования по ДДУ (214-ФЗ), а не квартира — дом не введён, выписки ЕГРН на квартиру и кадастрового номера ещё нет, площадь проектная. Объект — по договору: номер и дата, застройщик, корпус, условный номер. Договор с отметкой о регистрации — в документы дела.' }];
  if (!has('ddu_number') || !has('ddu_date')) out.push({ id: 'ddu_doc', text: 'Не указаны номер или дата ДДУ — уточните у заказчика или возьмите из договора.' });
  if (has('cadastral')) out.push({ id: 'ddu_cadastral', text: 'В заявке кадастровый номер, а у квартиры по ДДУ его ещё нет: возможно, это номер участка или дом уже введён. Уточните у заказчика; если квартира уже в собственности — оценивается квартира, поменяйте «Что оцениваем».' });
  const day = dduDay(fields.ddu_handover);
  if (day && day < today) out.push({ id: 'ddu_late', text: `Срок передачи по договору (${String(fields.ddu_handover).trim()}) уже прошёл — уточните у заказчика, введён ли дом и подписан ли акт приёма-передачи: если квартира передана, оценивается уже квартира.` });
  return out;
}

// Черновик (2.541): строка об объекте — в «Задание на оценку» (таблица задания), допущение — в раздел допущений. Обе узнаются
// по началу и заменяются; встают сразу под заголовком раздела. Только «Квартира в новостройке (права по ДДУ)».
export const DDU_TASK_HEAD = 'Объект оценки — право требования по ДДУ:';
export const DDU_ASSUME_HEAD = 'Дом не введён в эксплуатацию:';
const ddu = (serviceId, fields) => serviceId === 'realty' && fields?.object_type === 'ddu';
const val = (fields, id) => String(fields?.[id] ?? '').replace(/\s+/g, ' ').trim();
const area = (v) => String(v).replace('.', ',');

// kind — вид стоимости из задания на оценку (2.282), если есть; иначе — рыночная стоимость права требования.
export function dduTaskLine(serviceId, fields = {}, kind = null) {
  if (!ddu(serviceId, fields)) return null;
  const GAP = '[заполнить]';
  const num = val(fields, 'ddu_number');
  const day = val(fields, 'ddu_date');
  const contract = `договор участия в долевом строительстве № ${num || GAP} от ${day || GAP}`;
  const parts = [
    `застройщик — ${val(fields, 'ddu_developer') || GAP}`,
    val(fields, 'ddu_complex') ? `объект строительства — ${val(fields, 'ddu_complex')}` : null,
    `квартира с условным номером ${val(fields, 'ddu_unit') || GAP}`,
    `проектная площадь — ${val(fields, 'ddu_area') ? `${area(val(fields, 'ddu_area'))} кв. м` : GAP}`,
    val(fields, 'ddu_handover') ? `срок передачи по договору — ${val(fields, 'ddu_handover')}` : null,
  ].filter(Boolean);
  const k = String(kind ?? '').trim();
  return `${DDU_TASK_HEAD} ${contract} (214-ФЗ); ${parts.join('; ')}. Оцениваемые права — право требования передачи квартиры после ввода дома в эксплуатацию, не право собственности на квартиру. Вид стоимости — ${k ? `${k} (по заданию на оценку)` : 'рыночная стоимость права требования'}.`;
}

export function dduAssumption(serviceId, fields = {}) {
  if (!ddu(serviceId, fields)) return null;
  return `${DDU_ASSUME_HEAD} квартира как объект недвижимости ещё не образована — кадастрового номера и выписки ЕГРН на неё нет; объект описан по договору участия в долевом строительстве. Площадь — проектная, по договору; фактическая площадь после обмеров может отличаться. Принято, что договор исполняется застройщиком и дольщиком в установленный срок; надёжность застройщика и действительность договора оценщик не проверяет.`;
}

function placeUnder(body, sections, line, head, pick) {
  if (!line) return body;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(head));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const s = sections.find(pick);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${line}${body.slice(at)}`;
}

export const placeDduTask = (body, sections, line) => placeUnder(body, sections, line, DDU_TASK_HEAD, (x) => x.table === 'task');
export const placeDduAssumption = (body, sections, line) => placeUnder(body, sections, line, DDU_ASSUME_HEAD, (x) => isAssumptions(x.title));

// Осмотр (2.544): дом строится — в квартиру не попасть, осмотра квартиры нет. Своя фраза «осмотр не проводился» в черновик
// вместо общей: что осматривать нечего и откуда сведения о квартире. Стройплощадку осмотрели — фраза не нужна.
export const DDU_NO_INSPECT = 'Осмотр квартиры не проводился: дом не введён в эксплуатацию, квартира участнику долевого строительства не передана; сведения о квартире — по договору участия в долевом строительстве и плану квартиры из договора.';
export const dduNoInspect = (serviceId, fields) => (ddu(serviceId, fields) ? DDU_NO_INSPECT : null);
