-- Шаблон отчёта организации (2.29; решение Дамира 03.10.2026, г): руководитель загружает .docx со стилями, шапкой,
-- логотипом и реквизитами — черновик эксперта от этой организации собирается в нём. Один шаблон на организацию;
-- новый заменяет прежний. Видят руководитель и сотрудники организации.
create table org_templates (
  org_id       uuid primary key references organizations(id) on delete cascade,
  storage_key  text not null unique,
  filename     text not null check (length(filename) between 1 and 255),
  size_bytes   int not null check (size_bytes > 0),
  -- В шаблоне есть абзац «{{ОТЧЁТ}}» — отчёт встаёт на его место; нет — после содержимого шаблона.
  marked       boolean not null default false,
  uploaded_by  uuid not null references users(id),
  uploaded_at  timestamptz not null default now()
);
