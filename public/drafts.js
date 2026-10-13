// Черновики на телефоне (задача штаба: приложение с экрана «Домой»): снятые, но ещё не отправленные фото осмотра и
// несохранённые данные с объекта. Хранятся в браузере этого телефона (IndexedDB) и никуда не уходят, кроме своего
// сервера; отправлено или ссылка закрыта — черновик удаляется. Браузер не даёт хранить — всё работает как раньше, в памяти.
const DB = 'delo-drafts';
const STORE = 'drafts';

let opening = null;
function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch(() => null);
  }
  return opening;
}

async function run(mode, fn) {
  try {
    const db = await open();
    if (!db) return undefined;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { return undefined; }
}

export const getDraft = (key) => run('readonly', (s) => s.get(key));
export const putDraft = (key, value) => run('readwrite', (s) => s.put(value, key));
export const dropDraft = (key) => run('readwrite', (s) => s.delete(key));
