// Шаблон отчёта организации (2.29): руководитель загружает и убирает .docx, сотрудники видят и скачивают. Тексты — через textContent.
import { api, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
let org = null;
let maxBytes = 5 * 1024 * 1024;

export async function loadOrgTemplate(current) {
  org = current;
  const box = $('org-template-box');
  say($('org-template-msg'), '');
  if (!org.my_role) { box.classList.add('hidden'); return; }
  render(await api('GET', `/api/orgs/${org.id}/template`));
  box.classList.remove('hidden');
}

function render(r) {
  maxBytes = r.max_bytes ?? maxBytes;
  const t = r.template;
  $('org-template-state').textContent = t
    ? `Загружен «${t.filename}» ${dateRu(t.uploaded_at)}. ${t.marked ? 'Отчёт встаёт на место абзаца {{ОТЧЁТ}}.' : 'Отчёт идёт после содержимого шаблона.'}`
    : `Шаблон не загружен — черновики собираются в стандартном оформлении.${r.manage ? '' : ' Загружает руководитель.'}`;
  $('org-template-hint').classList.toggle('hidden', !r.manage);
  $('org-template-pick').classList.toggle('hidden', !r.manage);
  $('org-template-pick').textContent = t ? 'Заменить шаблон' : 'Загрузить шаблон';
  $('org-template-get').classList.toggle('hidden', !t);
  $('org-template-remove').classList.toggle('hidden', !(t && r.manage));
}

$('org-template-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) return say($('org-template-msg'), 'Шаблон — файл Word .docx (не .doc, не .docm)');
  if (file.size > maxBytes) return say($('org-template-msg'), 'Файл больше 5 МБ');
  say($('org-template-msg'), 'Загружаем…', 'ok');
  try {
    await api('POST', `/api/orgs/${org.id}/template`, file, { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) });
    render(await api('GET', `/api/orgs/${org.id}/template`));
    say($('org-template-msg'), 'Шаблон сохранён', 'ok');
  } catch (err) { say($('org-template-msg'), err.message); }
});

$('org-template-get').addEventListener('click', async () => {
  try {
    const { url } = await api('GET', `/api/orgs/${org.id}/template/file`);
    location.href = url;
  } catch (err) { say($('org-template-msg'), err.message); }
});

$('org-template-remove').addEventListener('click', async () => {
  if (!confirm('Убрать шаблон? Новые черновики будут в стандартном оформлении; уже сданные файлы не изменятся.')) return;
  try {
    await api('DELETE', `/api/orgs/${org.id}/template`);
    render(await api('GET', `/api/orgs/${org.id}/template`));
    say($('org-template-msg'), 'Шаблон убран', 'ok');
  } catch (err) { say($('org-template-msg'), err.message); }
});
