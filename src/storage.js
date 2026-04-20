'use strict';

// ============================================================
//  INDEXEDDB
// ============================================================
const IDB_NAME    = 'recon_tool';
const IDB_VERSION = 2;
const IDB_STORE   = 'slots';
let db = null;

function idbSetStatus(state, text) {
  const dot   = document.getElementById('idb-dot');
  const label = document.getElementById('idb-label');
  if (!dot || !label) return;
  dot.className = 'idb-dot ' + state;
  label.textContent = text;
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function idbTx(mode) { return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE); }

async function idbPut(key, value) {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function idbGet(key) {
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbGetAll() {
  if (!db) return {};
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const out   = {};
    const kReq  = store.getAllKeys();
    kReq.onsuccess = () => {
      const keys  = kReq.result;
      let pending = keys.length;
      if (!pending) { resolve(out); return; }
      keys.forEach(k => {
        const vReq = store.get(k);
        vReq.onsuccess = () => { out[k] = vReq.result; if (--pending === 0) resolve(out); };
        vReq.onerror   = e => reject(e.target.error);
      });
    };
    kReq.onerror = e => reject(e.target.error);
  });
}

/** Lightweight cache inventory — returns only keys + _meta (no data payloads) */
async function idbGetInventory() {
  if (!db) return { keys: [], meta: {} };
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const kReq  = store.getAllKeys();
    kReq.onsuccess = () => {
      const keys = kReq.result || [];
      const metaReq = store.get('_meta');
      metaReq.onsuccess = () => resolve({ keys, meta: metaReq.result || {} });
      metaReq.onerror = e => reject(e.target.error);
    };
    kReq.onerror = e => reject(e.target.error);
  });
}

async function idbDelete(key) {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function persistSlot(key, value, filename) {
  idbSetStatus('working', 'Saving…');
  try {
    await idbPut(key, value);
    let meta = {};
    try { const m = await idbGet('_meta'); if (m) meta = m; } catch(e) {}
    meta[key] = { filename: filename || key, savedAt: Date.now() };
    await idbPut('_meta', meta);
    idbSetStatus('ready', 'Saved');
    if (typeof refreshFilesBadge === 'function') refreshFilesBadge();
  } catch(e) {
    idbSetStatus('error', 'Save failed');
    console.error('IDB write error', e);
  }
}
