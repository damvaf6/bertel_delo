-- Внутренняя переписка руководителя организации и эксперта по делу (2.28). Лента — по заявке и организации, от которой
-- эксперт ведёт дело: сменил организацию или ушёл из неё — прежняя лента новому руководителю не видна, старому — тоже.
-- Заказчик и диспетчер её не видят; в письма по заявке (1.9) она не уходит (отдельная таблица, не order_messages).
create table org_messages (
  id bigserial primary key,
  order_id uuid not null references orders(id),
  org_id uuid not null references organizations(id),
  author_id uuid not null references users(id),
  side text not null check (side in ('head', 'expert')),
  body text not null,
  at timestamptz not null default now()
);
create index org_messages_order on org_messages(order_id, org_id, id);
