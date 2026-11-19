// 端末内データベース（IndexedDB）。データは端末の外へ送信しません。
const DB_NAME = 'shinnyo-otomo';
const DB_VERSION = 1;

export const STORES = ['persons', 'segaki', 'sesshin', 'calendars', 'settings'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('persons')) db.createObjectStore('persons', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('segaki')) {
        const s = db.createObjectStore('segaki', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('sesshin')) {
        const s = db.createObjectStore('sesshin', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      // 月ごとのイベントカレンダー（key: 'YYYY-MM'）
      if (!db.objectStoreNames.contains('calendars')) db.createObjectStore('calendars', { keyPath: 'month' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  getAll(store) { return tx(store, 'readonly', s => reqP(s.getAll())); },
  get(store, key) { return tx(store, 'readonly', s => reqP(s.get(key))); },
  put(store, value) { return tx(store, 'readwrite', s => reqP(s.put(value))); },
  delete(store, key) { return tx(store, 'readwrite', s => reqP(s.delete(key))); },

  async getSetting(key, fallback) {
    const row = await this.get('settings', key);
    return row ? row.value : fallback;
  },
  setSetting(key, value) { return this.put('settings', { key, value }); },

  // バックアップ機能を後付けするための入口（今は画面からは使っていません）
  async exportAll() {
    const out = { app: 'shinnyo-otomo', version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
    for (const s of STORES) out.data[s] = await this.getAll(s);
    return out;
  },
  async importAll(dump) {
    if (!dump || dump.app !== 'shinnyo-otomo' || typeof dump.data !== 'object') throw new Error('形式が違います');
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORES, 'readwrite');
      for (const s of STORES) {
        const os = t.objectStore(s);
        os.clear();
        for (const row of (dump.data[s] || [])) os.put(row);
      }
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },
};

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// 端末のストレージを消されにくくする（対応ブラウザのみ）
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* 非対応 */ }
  return false;
}
