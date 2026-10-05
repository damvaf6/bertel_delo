// Открытая демо-площадка (решение Дамира 05.10.2026, вопрос 21, вариант Б): только вымышленные данные, вход кнопками
// «Войти как …» (без телефона и кода), без настоящих поставщиков (config.mjs), закрыта от поисковиков, каждую ночь
// данные стираются и наполняются заново теми же делами, что для показа (src/demo/seed.mjs). Выключается одним действием
// — workflow «Demo (Yandex Cloud)», действие off: адрес закрывается для посторонних.
import { openSession } from '../auth/auth.mjs';
import { grantRole } from '../tools/grant-role.mjs';
import { seedDemo, DEMO_PEOPLE } from './seed.mjs';

// Кнопки входа: кто из демо-людей и как подписан на странице входа (порядок — как в экскурсии).
export const DEMO_ROLES = [
  { as: 'lawyer', title: 'Юрист фирмы', hint: 'заказывает экспертизы от имени юрфирмы' },
  { as: 'petrov', title: 'Частный заказчик', hint: 'наследство, ущерб, продажа' },
  { as: 'morozova', title: 'Эксперт-оценщик', hint: 'дела, осмотр, черновик, подпись' },
  { as: 'headA', title: 'Руководитель экспертной организации', hint: 'дела экспертов, подпись организации' },
  { as: 'dispatcher', title: 'Диспетчер платформы', hint: 'цена, подбор, проверка, деньги' },
];
// Администратор демо-площадки — только для наполнения (кнопки входа за него нет).
export const DEMO_ADMIN = '+79990001000';

export function demoPerson(as) {
  const role = DEMO_ROLES.find((r) => r.as === as);
  return role ? DEMO_PEOPLE[as] : null;
}

// Сброс: стереть все данные (схема остаётся), назначить администратора и заново наполнить делами — обычными операциями
// ядра по адресу самого сервера (base), как в проверках. Вход демо-людей — сразу сессией, без кода.
export async function resetDemo({ sql, base, log = () => {} }) {
  const tables = (await sql`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`)
    .map((t) => `"${t.tablename}"`);
  if (tables.length) await sql.pool.query(`truncate ${tables.join(', ')} restart identity cascade`);
  log(`данные стёрты: таблиц ${tables.length}`);
  await grantRole(sql, DEMO_ADMIN, 'admin');
  const login = async (phone) => {
    const { user, token } = await openSession(sql, phone, 'auth.demo_seed');
    return { cookie: `delo_sid=${token}`, user };
  };
  const r = await seedDemo({ base, login, adminPhone: DEMO_ADMIN, log });
  return { cases: Object.keys(r.cases).length, orgs: Object.keys(r.orgs).length };
}
