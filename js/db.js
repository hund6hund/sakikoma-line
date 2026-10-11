// IndexedDB の薄いラッパー。記録は測位ごとに逐次書き込む。

const DB_NAME = 'sakikoma-line';
const DB_VER = 1;
export const STORES = ['stations', 'runs', 'track', 'passages', 'stops', 'dias', 'kv'];

let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('stations', { keyPath: 'id' });
      db.createObjectStore('runs', { keyPath: 'id' });
      db.createObjectStore('track', { keyPath: 'key', autoIncrement: true }).createIndex('runId', 'runId');
      db.createObjectStore('passages', { keyPath: 'id' }).createIndex('runId', 'runId');
      db.createObjectStore('stops', { keyPath: 'id' }).createIndex('runId', 'runId');
      db.createObjectStore('dias', { keyPath: 'id' });
      db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) {
  return done((await store(name)).get(key));
}

export async function all(name) {
  return done((await store(name)).getAll());
}

export async function put(name, value) {
  return done((await store(name, 'readwrite')).put(value));
}

export async function del(name, key) {
  return done((await store(name, 'readwrite')).delete(key));
}

export async function byIndex(name, index, key) {
  return done((await store(name)).index(index).getAll(key));
}

/** 複数件をひとつのトランザクションで書き込む */
export async function putMany(name, values) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  for (const v of values) os.put(v);
  return txDone(tx);
}

export async function deleteByIndex(name, index, key) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const keys = await done(tx.objectStore(name).index(index).getAllKeys(key));
  for (const k of keys) tx.objectStore(name).delete(k);
  return txDone(tx);
}

export async function clear(name) {
  return done((await store(name, 'readwrite')).clear());
}

export async function getKv(key, fallback = null) {
  const r = await get('kv', key);
  return r ? r.value : fallback;
}

export async function setKv(key, value) {
  return put('kv', { key, value });
}
