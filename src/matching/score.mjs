// Подбор исполнителя: оценка специалиста по признакам (устав, этап 1). Чистые функции — без базы, легко проверять.
// Обязательное условие — допуск на услугу (проверяется отдельно, без допуска в подбор не попадают).
// Остальное — признаки с весами; диспетчер видит оценку по каждому и может выбрать любого допущенного.

export const WEIGHTS = { region: 25, load: 35, deadline: 15, quality: 25 };
export const URGENT_DAYS = 3;
// Меньше стольких предложений в истории — доля принятых не показательна, берётся нейтральная оценка.
export const QUALITY_MIN_OFFERS = 3;

export const FEATURE_NAMES = {
  region: 'Район работы',
  load: 'Загрузка',
  deadline: 'Срок',
  quality: 'Качество прошлых работ',
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// spec: { regions, capacity, external_load }; stats: { open (дел сейчас), offers, accepted }; order: { fields, deadline };
// daysLeft — дней до срока (null, если срока нет).
export function scoreSpecialist(spec, stats, order, daysLeft) {
  const load = stats.open + spec.external_load;
  const loadScore = clamp(100 * (1 - load / spec.capacity));
  const region = order.fields?.region;
  const regionScore = !region ? 100 : spec.regions.includes(region) ? 100 : 0;
  // Срочное дело лучше отдать тому, у кого свободнее; не срочное — срок не ограничивает.
  const urgent = daysLeft !== null && daysLeft <= URGENT_DAYS;
  const deadlineScore = urgent ? loadScore : 100;
  const enough = stats.offers >= QUALITY_MIN_OFFERS;
  const qualityScore = enough ? clamp((100 * stats.accepted) / stats.offers) : 70;

  const features = {
    region: { score: regionScore, note: !region ? 'район не указан' : regionScore ? 'работает в этом районе' : 'вне района работы' },
    load: { score: loadScore, note: `дел сейчас: ${load} из ${spec.capacity}` },
    deadline: { score: deadlineScore, note: urgent ? `срочно (дней: ${Math.max(daysLeft, 0)})` : 'срок не жмёт' },
    quality: { score: qualityScore, note: enough ? `приняты ${stats.accepted} из ${stats.offers} предложений` : 'пока мало данных' },
  };
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const total = Math.round(Object.entries(WEIGHTS).reduce((a, [k, w]) => a + features[k].score * w, 0) / sum);
  return { total, features: Object.fromEntries(Object.entries(features).map(([k, f]) => [k, { ...f, name: FEATURE_NAMES[k], weight: WEIGHTS[k] }])) };
}
