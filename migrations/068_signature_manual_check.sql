-- 068 · Подписанный результат исполнителя при ручной проверке (задача штаба 3f817197-…-81ac, SIGN_PROVIDER=manual): исполнитель
-- загружает файл и открепленную подпись .sig из своей программы; верна ли подпись, проверяет сотрудник платформы на Госуслугах
-- и ставит отметку. manual_check: null — подпись проверил поставщик сам (поддельная на площадке, будущий УЦ);
-- 'pending' — ждёт проверки; 'ok' — «подписано КЭП, проверено»; 'bad' — не подтвердилась (manual_note — почему).
alter table document_signatures add column manual_check text check (manual_check in ('pending', 'ok', 'bad'));
alter table document_signatures add column manual_checked_by uuid references users(id);
alter table document_signatures add column manual_checked_at timestamptz;
alter table document_signatures add column manual_note text;
alter table document_signatures add constraint document_signatures_manual_by
  check ((manual_check in ('ok', 'bad')) = (manual_checked_by is not null and manual_checked_at is not null));
