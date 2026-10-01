// Мост CRM → Платформа (задача 1.10). Операции моста зовёт только БЕРТЕЛ CRM, каждое сообщение подписано ключом моста
// (src/bridge/signature.mjs); без ключа в настройках мост выключен. Разбор и правила — src/bridge/crm.mjs.
// Повтор сообщения с тем же номером не обрабатывается второй раз — отдаётся прежний итог.
import { HttpError } from '../http/core.mjs';
import { crmView, receiveLoad, receiveOffers, receiveProfiles } from '../bridge/crm.mjs';
import { audit } from './util.mjs';

async function once(sql, message, kind, fn) {
  return sql.tx(async (tx) => {
    const fresh = await tx`insert into crm_bridge_messages (id, kind, result) values (${message.id}, ${kind}, '{}')
                           on conflict (id) do nothing returning id`;
    if (!fresh.length) {
      const prev = await tx.one`select kind, result from crm_bridge_messages where id = ${message.id}`;
      if (prev.kind !== kind) throw new HttpError(409, 'message_id_taken', 'Номер сообщения уже занят сообщением другого вида');
      return { ...prev.result, duplicate: true };
    }
    const result = await fn(tx);
    await tx`update crm_bridge_messages set result = ${JSON.stringify(result)} where id = ${message.id}`;
    // В журнал — только сколько и чем кончилось, без телефонов и почты.
    await audit(tx, null, `crm.bridge.${kind}`, 'crm_message', message.id, result.counts);
    return result;
  });
}

const bridgeOp = (id, path, kind, receive) => ({
  id, method: 'POST', path, auth: 'bridge', body: 'raw', limit: '2mb',
  async handler({ sql, message }) { return once(sql, message, kind, (tx) => receive(tx, message.data)); },
});

export function bridgeOps(cfg) {
  const ops = [{
    // Кабинет исполнителя: госзаказ из CRM — сколько дел там сейчас и открытые предложения (принимаются в CRM).
    id: 'specialist.crm', method: 'GET', path: '/api/specialist/crm', auth: 'user', access: 'self',
    async handler({ sql, actor }) { return { crm: await crmView(sql, cfg, actor.id) }; },
  }];
  if (cfg.crm.bridgeSecret) {
    ops.push(
      bridgeOp('bridge.crm.profiles', '/api/bridge/crm/profiles', 'profiles', receiveProfiles),
      bridgeOp('bridge.crm.load', '/api/bridge/crm/load', 'load', receiveLoad),
      bridgeOp('bridge.crm.offers', '/api/bridge/crm/offers', 'offers', receiveOffers),
    );
  }
  return ops;
}
