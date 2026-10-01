// Раздел «Управление» (только администратор): найти пользователя по номеру, назначить служебную роль, отключить.
import { api, el, say, formatPhone, ROLE_RU, PLATFORM_ROLE_RU } from '/common.js';
import { state, show } from '/shell.js';
import { serviceName } from '/match.js';

const $ = (id) => document.getElementById(id);
let found = null;

export async function showAdmin() {
  show('admin-view', 'admin');
  await loadStaff();
}

async function loadStaff() {
  const { users } = await api('GET', '/api/admin/staff');
  $('staff').replaceChildren(...users.map((u) => el('li', {},
    el('button', { class: 'open', onclick: () => { $('admin-phone').value = formatPhone(u.phone); find(u.phone); } },
      el('div', { class: 'title', text: u.full_name || formatPhone(u.phone) }),
      el('div', { class: 'muted', text: [PLATFORM_ROLE_RU[u.platform_role], u.full_name ? formatPhone(u.phone) : null, u.is_active ? null : 'отключён'].filter(Boolean).join(' · ') })))));
}

function render(u) {
  found = u;
  $('admin-user').classList.remove('hidden');
  $('admin-user-name').textContent = u.full_name || 'Имя не указано';
  const orgs = u.orgs.map((o) => `${o.name} (${ROLE_RU[o.role].toLowerCase()})`).join(', ');
  $('admin-user-meta').textContent = [formatPhone(u.phone), u.is_active ? 'доступ открыт' : 'отключён',
    orgs ? `организации: ${orgs}` : 'без организаций'].join(' · ');
  $('admin-role').value = u.platform_role || '';
  const self = u.id === state.me.user.id;
  $('admin-role').disabled = self;
  $('admin-save-role').disabled = self;
  $('admin-toggle').disabled = self;
  $('admin-toggle').textContent = u.is_active ? 'Отключить' : 'Включить';
  $('admin-toggle').className = u.is_active ? 'danger' : 'secondary';
  say($('admin-user-msg'), self ? 'Это Вы: свою роль и доступ изменить нельзя' : '', 'ok');
}

// ——— Специалист: профиль и допуски ———

let specialist = null;

async function loadSpecialist(userId) {
  const { specialists } = await api('GET', '/api/specialists');
  specialist = specialists.find((s) => s.user_id === userId) ?? null;
  $('admin-specialist').classList.remove('hidden');
  $('admin-specialist-state').textContent = specialist ? 'Этот человек — специалист.' : 'Пока не специалист. Сохраните профиль, чтобы сделать его специалистом.';
  $('sp-moscow').checked = specialist ? specialist.regions.includes('moscow') : true;
  $('sp-mo').checked = specialist ? specialist.regions.includes('mo') : true;
  $('sp-capacity').value = specialist ? String(specialist.capacity) : '5';
  $('sp-permits-box').classList.toggle('hidden', !specialist);
  $('sp-service').replaceChildren(...state.catalog.modules.flatMap((m) => m.services.map((s) => el('option', { value: `${m.id}/${s.id}`, text: `${m.name} · ${s.name}` }))));
  $('sp-permits').replaceChildren(...(specialist?.permits ?? []).map((p) => el('li', { class: 'row' },
    el('span', { text: `${serviceName(p.module, p.service)}${p.valid_until ? ` · до ${p.valid_until}` : ''}` }),
    el('button', { type: 'button', class: 'danger', 'data-action': 'remove-permit', onclick: () => removePermit(p) }, 'Убрать'))));
}

$('admin-specialist').addEventListener('submit', async (e) => {
  e.preventDefault();
  const regions = [['moscow', 'sp-moscow'], ['mo', 'sp-mo']].filter(([, id]) => $(id).checked).map(([r]) => r);
  if (!regions.length) return say($('sp-msg'), 'Выберите, где работает специалист');
  try {
    await api('PUT', `/api/admin/specialists/${found.id}`, { regions, capacity: Number($('sp-capacity').value) });
    await loadSpecialist(found.id);
    say($('sp-msg'), 'Профиль специалиста сохранён', 'ok');
  } catch (err) { say($('sp-msg'), err.message); }
});

$('sp-add-permit').addEventListener('click', async () => {
  const [module, service] = $('sp-service').value.split('/');
  try {
    await api('POST', `/api/admin/specialists/${found.id}/permits`, { module, service, valid_until: $('sp-until').value || null });
    await loadSpecialist(found.id);
    say($('sp-msg'), 'Допуск выдан', 'ok');
  } catch (err) { say($('sp-msg'), err.message); }
});

async function removePermit(p) {
  if (!confirm('Убрать допуск? Специалисту перестанут предлагать дела этой услуги.')) return;
  try {
    await api('DELETE', `/api/admin/specialists/${found.id}/permits/${encodeURIComponent(p.module)}/${encodeURIComponent(p.service)}`);
    await loadSpecialist(found.id);
    say($('sp-msg'), 'Допуск убран', 'ok');
  } catch (err) { say($('sp-msg'), err.message); }
}

async function find(phone) {
  say($('admin-msg'), '');
  $('admin-user').classList.add('hidden');
  try {
    const { user } = await api('GET', `/api/admin/users?phone=${encodeURIComponent(phone)}`);
    render(user);
    say($('sp-msg'), '');
    await loadSpecialist(user.id);
  } catch (err) { say($('admin-msg'), err.message); }
}

async function update(patch, done) {
  try {
    const { user } = await api('PATCH', `/api/admin/users/${found.id}`, patch);
    render(user);
    say($('admin-user-msg'), done, 'ok');
    await loadStaff();
  } catch (err) { say($('admin-user-msg'), err.message); }
}

$('admin-find').addEventListener('submit', (e) => {
  e.preventDefault();
  const phone = $('admin-phone').value.trim();
  if (!phone) return say($('admin-msg'), 'Укажите номер телефона');
  find(phone);
});

$('admin-save-role').addEventListener('click', () => update({ platform_role: $('admin-role').value || null }, 'Роль сохранена'));

$('admin-toggle').addEventListener('click', () => {
  if (found.is_active && !confirm('Отключить пользователя? Он сразу выйдет отовсюду и не сможет войти.')) return;
  update({ is_active: !found.is_active }, found.is_active ? 'Пользователь отключён' : 'Пользователь включён');
});
