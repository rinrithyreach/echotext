/**
 * EchoText — Audio store
 * Generated audio files can be several MB, so they live in IndexedDB rather
 * than localStorage. Records are keyed by the history item id.
 */
(function (App) {
  'use strict';

  const DB_NAME = 'voiceai';
  const DB_VERSION = 1;
  const STORE = 'audio';
  let dbPromise = null;

  function open() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Audio storage is blocked by another open tab.'));
      });
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  async function run(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
    });
  }

  App.AudioStore = {
    put(id, blob) {
      return run('readwrite', (store) => store.put({ id, blob, type: blob.type, savedAt: Date.now() }));
    },
    async get(id) {
      const record = await run('readonly', (store) => store.get(id));
      return record ? record.blob : null;
    },
    delete(id) {
      return run('readwrite', (store) => store.delete(id));
    },
    clear() {
      return run('readwrite', (store) => store.clear());
    },
  };
})(window.VoiceAI = window.VoiceAI || {});
