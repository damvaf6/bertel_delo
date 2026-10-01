// Подпись сообщений моста CRM → Платформа (задача 1.10).
// CRM подписывает каждое сообщение общим ключом моста (CRM_BRIDGE_SECRET, из Lockbox):
//   x-bridge-id        — номер сообщения (повтор с тем же номером не обрабатывается второй раз);
//   x-bridge-time      — время отправки, секунды Unix (старше 5 минут или из будущего — отклоняется);
//   x-bridge-signature — "sha256=" + HMAC-SHA256(ключ, `${time}.${id}.${исходный текст}`) в шестнадцатеричном виде.
// Любая ошибка подписи — «не найдено», без подробностей: снаружи не видно, что мост вообще есть.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';

export const BRIDGE_WINDOW_SEC = 300;
const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export function signBridge(secret, id, time, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${time}.${id}.`).update(body).digest('hex')}`;
}

export function verifyBridge(req, cfg, now = Date.now()) {
  const deny = () => new HttpError(404, 'not_found', 'Не найдено');
  const secret = cfg.crm?.bridgeSecret;
  if (!secret) throw deny();
  const id = req.get('x-bridge-id') || '';
  const time = req.get('x-bridge-time') || '';
  const got = Buffer.from(req.get('x-bridge-signature') || '');
  if (!ID_RE.test(id) || !/^\d{1,12}$/.test(time)) throw deny();
  if (Math.abs(now / 1000 - Number(time)) > BRIDGE_WINDOW_SEC) throw deny();
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const want = Buffer.from(signBridge(secret, id, time, body));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw deny();
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'Неверный формат сообщения'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_json', 'Неверный формат сообщения');
  return { id, data };
}
