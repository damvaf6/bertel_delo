// «Справка для нотариуса» (2.507) — Word из отчёта об оценке для наследства. Видят те, кому виден результат дела: заказчик —
// после выдачи (оплата и «готово»), эксперт и служебные — как только есть файл отчёта. Стоимость, номер и дата — из файла.
import { HttpError } from '../http/core.mjs';
import { executorSignOrg, seesResults } from '../access/policy.mjs';
import { heirValues, reportFacts, shareCase } from '../ai/report-checks.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { heirNoteData, heirNoteDoc } from '../docs/heir-note.mjs';
import { heirMain, heirNoteCase } from '../orders/inheritance.mjs';
import { editionDocs } from '../orgs/registry.mjs';
import { assignmentDocs, resultDocs } from './ai-ops.mjs';
import { inheritValueDate, valueDateFor } from './draft-ops.mjs';
import { audit, sendFile } from './util.mjs';

// Дело оценки для наследства, и вошедшему виден результат — справку можно предложить (без чтения файлов).
const heirNoteOffered = (actor, order) => heirNoteCase(order) && seesResults(actor, order);

export function heirOps() {
  return [
    {
      id: 'heir.note', method: 'GET', path: '/api/orders/:id/heir-note', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, registry, actor, order, providers, res }) {
        if (!heirNoteOffered(actor, order)) throw new HttpError(409, 'not_inheritance', 'Справка для нотариуса — только к отчёту об оценке для наследства после выдачи');
        const { docs } = editionDocs(order, await resultDocs(sql, providers.storage, order));
        if (!docs.length) throw new HttpError(409, 'no_result', 'Файла отчёта в деле ещё нет');
        const readable = docs.filter((d) => d.pages);
        const facts = reportFacts(readable, { share: shareCase(order.service, order.fields ?? {}) });
        if (facts.value_rub == null) throw new HttpError(409, 'no_value', 'В файле отчёта не нашлась рыночная стоимость — справку не собрать. Нотариусу подойдёт сам отчёт.');
        const svc = registry.service(order.module, order.service);
        const vd = valueDateFor(registry, order, await assignmentDocs(sql, providers.storage, order)) ?? inheritValueDate(registry, order);
        const [ex] = order.executor_user_id ? await sql`select full_name from users where id = ${order.executor_user_id}` : [];
        const org = await executorSignOrg(sql, order.executor_user_id);
        const data = heirNoteData({
          order, service: svc?.service.name ?? order.title, object: heirMain(order.service, order.fields ?? {}),
          facts, heir: heirValues(readable, order.service, order.fields ?? {}), valueDay: vd?.day ?? null,
          executor: ex?.full_name, org: org?.name,
        });
        await audit(sql, actor, 'heir.note', 'order', order.id, { number: data.number });
        return sendFile(res, providers, { ...heirNoteDoc(data), mime: DOCX_MIME });
      },
    },
  ];
}
