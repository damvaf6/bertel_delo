-- 012 · Черновик заключения от ИИ (задача 2.2). Эксперт получает черновик по данным заявки и фото, правит его в кабинете
-- и прикладывает итоговый файл результата сам. Заказчик черновик не видит; ИИ ничего не выдаёт заказчику сам.

alter table ai_usage drop constraint ai_usage_purpose_check;
alter table ai_usage add constraint ai_usage_purpose_check check (purpose in ('problem', 'assistant', 'review', 'mail', 'draft'));

-- Версии черновика: каждая подготовка ИИ ('ai') и каждое сохранение правки человеком ('edit') — новая строка, последняя —
-- текущий текст. Так видно, что написал ИИ и что поправил эксперт. inputs — какие фото и документы ИИ видел (без текста).
create table result_drafts (
  id        bigint generated always as identity primary key,
  order_id  uuid not null references orders(id),
  author_id uuid not null references users(id),
  source    text not null check (source in ('ai', 'edit')),
  body      text not null check (length(body) between 1 and 60000),
  model     text,
  inputs    jsonb not null default '{}',
  at        timestamptz not null default now()
);
create index result_drafts_order on result_drafts(order_id, id desc);
