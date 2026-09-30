// Общее для страниц: запросы к ядру и безопасный вывод текста.
// Пользовательский текст выводится только через textContent, разметка строкой не собирается (исправление Б-7).

export async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['x-delo-request'] = '1';
  if (body !== undefined) {
    if (body instanceof Blob) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(path, opts);
  let data = null;
  if (r.status !== 204) { try { data = await r.json(); } catch { data = null; } }
  if (!r.ok) {
    const err = new Error(data?.message || 'Ошибка, попробуйте позже');
    err.status = r.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function say(node, text, kind = 'error') {
  node.textContent = text || '';
  node.className = `msg ${text ? kind : ''}`;
}

export function formatPhone(p) {
  const d = String(p).replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}` : p;
}

export function formatSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

export const ROLE_RU = { head: 'Руководитель', senior: 'Старший', member: 'Сотрудник' };
export const PLATFORM_ROLE_RU = { dispatcher: 'Диспетчер', admin: 'Администратор' };
