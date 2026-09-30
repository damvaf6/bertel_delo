// Раздел «Управление» (только администратор): найти пользователя по номеру, назначить служебную роль, отключить.
import { api, el, say, formatPhone, ROLE_RU, PLATFORM_ROLE_RU } from '/common.js';
import { state, show } from '/shell.js';

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

async function find(phone) {
  say($('admin-msg'), '');
  $('admin-user').classList.add('hidden');
  try {
    const { user } = await api('GET', `/api/admin/users?phone=${encodeURIComponent(phone)}`);
    render(user);
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
