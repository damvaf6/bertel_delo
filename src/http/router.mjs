// Реестр операций. Каждая операция обязана объявить, кто её может вызвать:
//   auth: 'public'  — только с объяснением publicReason (вход, проверка работы);
//   auth: 'user' + access: 'self'          — действует только над данными самого вошедшего;
//   auth: 'user' + access: { resource, param, need } — предмет загружается и проверяется до обработчика;
//   auth: 'user' + access: { platform: 'admin' | 'staff' | 'dispatcher' } — только администратор / служебный (диспетчер или
//                                  администратор) / диспетчер платформы (остальным «не найдено»).
// Операция без объявления не запускается вовсе (в наследии было наоборот — Б-2, Б-3).
// csrf: false — только у открытой операции, которую зовёт внешний сервис (уведомление ЮKassa) и которая содержимому не верит.
import express from 'express';
import { HttpError, parseCookies } from './core.mjs';
import { authorize, authorizePlatform, LEVEL, RESOURCES } from '../access/policy.mjs';
import { sessionUser } from '../auth/auth.mjs';
import { deliverPending } from '../notify/notify.mjs';
import { deliverMail } from '../mail/outbox.mjs';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function validateOp(op) {
  const where = `операция ${op.id}`;
  if (!op.id || !METHODS.includes(op.method) || !op.path || typeof op.handler !== 'function') throw new Error(`${where}: неполное описание`);
  if (op.auth === 'public') {
    if (!op.publicReason) throw new Error(`${where}: открытая операция без объяснения`);
    if (op.access) throw new Error(`${where}: открытая операция с проверкой доступа — противоречие`);
    if (op.csrf !== undefined && op.csrf !== false) throw new Error(`${where}: csrf — только false`);
    return;
  }
  if (op.auth !== 'user') throw new Error(`${where}: auth должен быть 'public' или 'user'`);
  // Без признака нашей страницы можно звать только открытые операции (уведомления внешних сервисов).
  if (op.csrf !== undefined) throw new Error(`${where}: отключить защиту от подделки запроса можно только у открытой операции`);
  if (op.access === 'self') return;
  const a = op.access;
  if (a?.platform !== undefined) {
    if (!['admin', 'staff', 'dispatcher'].includes(a.platform) || Object.keys(a).length !== 1) throw new Error(`${where}: не описана проверка доступа`);
    return;
  }
  if (!a || !RESOURCES[a.resource] || !a.param || !(a.need in LEVEL) || a.need === 'none') throw new Error(`${where}: не описана проверка доступа`);
  if (!op.path.includes(`:${a.param}`)) throw new Error(`${where}: параметра :${a.param} нет в пути`);
}

export function mountOps(app, ops, deps) {
  const ids = new Set();
  for (const op of ops) {
    validateOp(op);
    if (ids.has(op.id)) throw new Error(`операция ${op.id} объявлена дважды`);
    ids.add(op.id);

    const parsers = op.body === 'raw'
      ? [express.raw({ type: () => true, limit: op.limit || '5mb' })]
      : [express.json({ limit: '64kb' })];

    app[op.method.toLowerCase()](op.path, ...parsers, async (req, res, next) => {
      try {
        // Защита от подделки запроса с чужого сайта: изменяющие запросы — только из наших страниц.
        if (op.method !== 'GET' && op.csrf !== false && req.get('x-delo-request') !== '1') throw new HttpError(403, 'csrf', 'Запрос отклонён');
        const ctx = { ...deps, req, res, params: req.params, query: req.query, body: req.body, op };
        if (op.rateLimit) op.rateLimit(req.ip);
        if (op.auth === 'user') {
          const token = parseCookies(req.headers.cookie).delo_sid;
          ctx.actor = await sessionUser(deps.sql, token);
          if (!ctx.actor) throw new HttpError(401, 'unauthorized', 'Нужно войти');
          if (op.access.platform) authorizePlatform(ctx.actor, op.access.platform);
          else if (op.access !== 'self') Object.assign(ctx, await authorize(deps.sql, ctx.actor, op.access, req.params));
        }
        const out = await op.handler(ctx);
        // Изменяющая операция могла записать уведомления — СМС и письма уходят сразу; неудачные повторит обход в server.mjs.
        if (op.method !== 'GET') {
          await deliverPending(deps.sql, deps.providers).catch((e) => console.error('уведомления:', e?.message || e));
          await deliverMail(deps.sql, deps.providers, deps.cfg).catch((e) => console.error('письма:', e?.message || e));
        }
        if (res.headersSent) return;
        if (out === undefined) res.status(204).end();
        else res.json(out); // код ответа обработчик может задать сам: ctx.res.status(201)
      } catch (e) { next(e); }
    });
  }
  return [...ids];
}

// Ошибки наружу — только код и понятный текст; подробности — в журнал сервера (исправление Б-11).
export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Слишком большой файл или запрос' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Неверный формат запроса' });
    console.error(`[${req.method} ${req.path}]`, err?.stack || err);
    res.status(500).json({ error: 'internal', message: 'Внутренняя ошибка, попробуйте позже' });
  };
}
