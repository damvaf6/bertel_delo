// Раздел «Организации»: мои организации, приглашения, создание; страница организации — состав, роли, приглашения.
import { api, el, say, formatPhone, ROLE_RU } from '/common.js';
import { state, show, notFoundView, refreshMe } from '/shell.js';
import { loadOrgSign } from '/orgsign.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
let org = null; // открытая организация: { ...org, my_role, manage }

export async function showOrgs() {
  show('orgs-view', 'orgs');
  say($('invites-msg'), '');
  say($('org-new-msg'), '');
  await Promise.all([loadInvites(), loadOrgs()]);
}

async function loadInvites() {
  const { invites } = await api('GET', '/api/invites');
  $('invites-box').classList.toggle('hidden', invites.length === 0);
  $('invites').replaceChildren(...invites.map((i) => el('li', {},
    el('div', { class: 'title', text: i.org_name }),
    el('div', { class: 'muted', text: `Вас приглашают: ${i.role_ru} · до ${dateRu(i.expires_at)}` }),
    el('div', { class: 'row gap' },
      el('button', { onclick: () => answer(i, 'accept') }, 'Принять'),
      el('button', { class: 'secondary', onclick: () => answer(i, 'decline') }, 'Отклонить')))));
}

async function answer(invite, action) {
  try {
    await api('POST', `/api/invites/${invite.id}/${action}`);
    await refreshMe();
    if (action === 'accept') { location.hash = `org=${invite.org_id}`; return; }
    await loadInvites();
    say($('invites-msg'), 'Приглашение отклонено', 'ok');
  } catch (err) {
    say($('invites-msg'), err.message);
    await loadInvites();
  }
}

async function loadOrgs() {
  const { orgs } = await api('GET', '/api/orgs');
  $('orgs').replaceChildren(...orgs.map((o) => el('li', {},
    el('button', { class: 'open', onclick: () => { location.hash = `org=${o.id}`; } },
      el('div', { class: 'title', text: o.name }),
      el('div', { class: 'muted', text: `Ваша роль: ${ROLE_RU[o.my_role]}` })))));
  $('orgs-empty').classList.toggle('hidden', orgs.length > 0);
}

$('new-org').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('org-name').value.trim();
  if (!name) return say($('org-new-msg'), 'Укажите название');
  const inn = $('org-inn').value.trim();
  $('create-org').disabled = true;
  try {
    const { org: made } = await api('POST', '/api/orgs', inn ? { name, inn } : { name });
    $('org-name').value = '';
    $('org-inn').value = '';
    await refreshMe();
    location.hash = `org=${made.id}`;
  } catch (err) { say($('org-new-msg'), err.message); } finally { $('create-org').disabled = false; }
});

export async function showOrg(id) {
  try {
    const r = await api('GET', `/api/orgs/${id}`);
    org = { ...r.org, my_role: r.my_role, manage: r.manage };
  } catch (err) {
    if (err.status === 404) { org = null; return notFoundView('Организация не найдена', 'orgs'); }
    throw err;
  }
  $('org-title').textContent = org.name;
  $('org-meta').textContent = [org.inn ? `ИНН ${org.inn}` : null, org.my_role ? `Ваша роль: ${ROLE_RU[org.my_role]}` : null]
    .filter(Boolean).join(' · ');
  $('org-edit').classList.toggle('hidden', !org.manage);
  $('invite-box').classList.toggle('hidden', !org.manage);
  $('leave-org').parentElement.classList.toggle('hidden', !org.my_role);
  $('org-edit-name').value = org.name;
  $('org-edit-inn').value = org.inn || '';
  for (const m of ['org-edit-msg', 'members-msg', 'invite-msg', 'leave-msg', 'org-sign-msg']) say($(m), '');
  $('org-sign-box').classList.add('hidden');
  show('org-view', 'orgs');
  await Promise.all([loadMembers(), org.manage ? loadOrgInvites() : null, org.manage ? loadOrgSign(org) : null]);
}

async function loadMembers() {
  const { members } = await api('GET', `/api/orgs/${org.id}/members`);
  const meId = state.me.user.id;
  $('members').replaceChildren(...members.map((m) => {
    const name = m.full_name || (m.phone ? formatPhone(m.phone) : 'Без имени');
    const facts = [ROLE_RU[m.role], m.full_name && m.phone ? formatPhone(m.phone) : null,
      m.orders !== undefined ? `дел: ${m.orders}` : null, m.user_id === meId ? 'это Вы' : null].filter(Boolean);
    const li = el('li', { 'data-user': m.user_id },
      el('div', { class: 'title', text: name }),
      el('div', { class: 'muted', text: facts.join(' · ') }));
    if (org.manage) {
      const sel = el('select', { 'aria-label': `Роль: ${name}` },
        ...Object.entries(ROLE_RU).map(([v, t]) => el('option', { value: v, text: t })));
      sel.value = m.role;
      li.append(el('div', { class: 'row gap' }, sel,
        el('button', { class: 'secondary', onclick: () => setRole(m, sel.value) }, 'Сменить роль'),
        ...(m.user_id === meId ? [] : [el('button', { class: 'danger', onclick: () => removeMember(m, name) }, 'Убрать')])));
    }
    return li;
  }));
}

async function setRole(m, role) {
  if (role === m.role) return say($('members-msg'), 'Роль не изменилась');
  try {
    await api('PATCH', `/api/orgs/${org.id}/members/${m.user_id}`, { role });
    say($('members-msg'), 'Роль изменена', 'ok');
    if (m.user_id === state.me.user.id) { await refreshMe(); return showOrg(org.id); }
    await loadMembers();
  } catch (err) { say($('members-msg'), err.message); }
}

async function removeMember(m, name) {
  if (!confirm(`Убрать «${name}» из организации? Дела, которые сотрудник вёл от имени организации, останутся у неё.`)) return;
  try {
    await api('DELETE', `/api/orgs/${org.id}/members/${m.user_id}`);
    say($('members-msg'), 'Сотрудник убран', 'ok');
    await loadMembers();
  } catch (err) { say($('members-msg'), err.message); }
}

async function loadOrgInvites() {
  const { invites } = await api('GET', `/api/orgs/${org.id}/invites`);
  $('pending-title').classList.toggle('hidden', invites.length === 0);
  $('org-invites').replaceChildren(...invites.map((i) => el('li', { class: 'doc' },
    el('div', {},
      el('div', { class: 'name', text: formatPhone(i.phone) }),
      el('div', { class: 'muted', text: `${ROLE_RU[i.role]} · до ${dateRu(i.expires_at)}` })),
    el('button', { type: 'button', class: 'danger', onclick: () => revoke(i) }, 'Отозвать'))));
}

async function revoke(i) {
  if (!confirm(`Отозвать приглашение для ${formatPhone(i.phone)}?`)) return;
  try {
    await api('DELETE', `/api/invites/${i.id}`);
    say($('invite-msg'), 'Приглашение отозвано', 'ok');
    await loadOrgInvites();
  } catch (err) { say($('invite-msg'), err.message); }
}

$('invite-box').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = $('invite-phone').value.trim();
  if (!phone) return say($('invite-msg'), 'Укажите номер телефона');
  $('invite').disabled = true;
  try {
    await api('POST', `/api/orgs/${org.id}/invites`, { phone, role: $('invite-role').value });
    $('invite-phone').value = '';
    say($('invite-msg'), 'Приглашение отправлено', 'ok');
    await loadOrgInvites();
  } catch (err) { say($('invite-msg'), err.message); } finally { $('invite').disabled = false; }
});

$('org-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('org-edit-name').value.trim();
  if (!name) return say($('org-edit-msg'), 'Укажите название');
  $('org-save').disabled = true;
  try {
    const r = await api('PATCH', `/api/orgs/${org.id}`, { name, inn: $('org-edit-inn').value.trim() || null });
    org = { ...org, ...r.org };
    $('org-title').textContent = org.name;
    await refreshMe();
    say($('org-edit-msg'), 'Сохранено', 'ok');
  } catch (err) { say($('org-edit-msg'), err.message); } finally { $('org-save').disabled = false; }
});

$('leave-org').addEventListener('click', async () => {
  if (!confirm(`Выйти из организации «${org.name}»? Дела организации останутся у неё, Вы перестанете их видеть.`)) return;
  try {
    await api('POST', `/api/orgs/${org.id}/leave`);
    await refreshMe();
    location.hash = 'orgs';
  } catch (err) { say($('leave-msg'), err.message); }
});

$('org-back').addEventListener('click', () => { location.hash = 'orgs'; });
