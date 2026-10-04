// Общие части HTTP: ошибки, заголовки безопасности, ограничение частоты, cookie.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const notFound = () => new HttpError(404, 'not_found', 'Не найдено');

// Строгая политика: только свои ресурсы, никаких внешних шрифтов и скриптов (Б-20, Б-22).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(cfg) {
  // Прямая загрузка в хранилище (2.49): браузеру разрешено отправлять файлы ещё и на адрес хранилища.
  const storage = cfg?.providers?.storage === 's3' ? new URL(cfg.s3.publicEndpoint || cfg.s3.endpoint).origin : null;
  const csp = storage ? CSP.replace("connect-src 'self'", `connect-src 'self' ${storage}`) : CSP;
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Геометка нужна только странице дистанционного осмотра (2.3): там телефон по разрешению владельца сообщает место.
    const inspect = req.path === '/osmotr' || req.path === '/osmotr.html';
    res.setHeader('Permissions-Policy', `camera=(), microphone=(), geolocation=(${inspect ? 'self' : ''})`);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (cfg.live) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// Простое ограничение частоты в памяти одного экземпляра (по адресу). Основные лимиты входа — в базе, по номеру.
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start >= windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
    h.n += 1;
    if (hits.size > 50_000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    if (h.n > max) throw new HttpError(429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(cfg, token, maxAgeSec) {
  const parts = [`delo_sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (cfg.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
