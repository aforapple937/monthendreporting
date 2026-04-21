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
    const kReq  = store.getAllKeys();
    const vReq  = store.getAll();
    const out   = {};
    let done = 0;
    const finish = () => { if (++done === 2) resolve(out); };
    kReq.onsuccess = () => {
      const keys = kReq.result || [];
      vReq.onsuccess = () => {
        const vals = vReq.result || [];
        for (let i = 0; i < keys.length; i++) out[keys[i]] = vals[i];
        finish();
      };
      vReq.onerror = e => reject(e.target.error);
      finish();
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
    const mReq  = store.get('_meta');
    let keys = null, meta = null, settled = false;
    const maybeDone = () => {
      if (settled || keys === null || meta === null) return;
      settled = true;
      resolve({ keys, meta: meta || {} });
    };
    kReq.onsuccess = () => { keys = kReq.result || []; maybeDone(); };
    mReq.onsuccess = () => { meta = mReq.result || {}; maybeDone(); };
    kReq.onerror = e => reject(e.target.error);
    mReq.onerror = e => reject(e.target.error);
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

/**
 * Write a slot and refresh its entry in `_meta` inside a single transaction,
 * so a crash can't leave the slot saved but unindexed (or vice versa).
 */
async function persistSlot(key, value, filename) {
  if (!db) return;
  idbSetStatus('working', 'Saving…');
  try {
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(value, key);
      const mReq = store.get('_meta');
      mReq.onsuccess = () => {
        const meta = mReq.result || {};
        meta[key] = { filename: filename || key, savedAt: Date.now() };
        store.put(meta, '_meta');
      };
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
      tx.onabort    = e => reject(e.target.error);
    });
    idbSetStatus('ready', 'Saved');
    if (typeof refreshFilesBadge === 'function') refreshFilesBadge();
  } catch(e) {
    idbSetStatus('error', 'Save failed');
    console.error('IDB write error', e);
  }
}
