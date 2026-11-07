/** Atomic checkpoints: a saved section and the completed count always commit together. */
(function (App) {
  'use strict';
  let pending;
  function open() {
    if (!pending) {
      pending = new Promise((resolve, reject) => {
        const request = indexedDB.open('voiceai-generations', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('jobs', { keyPath: 'id' });
          request.result.createObjectStore('parts', { keyPath: ['jobId', 'index'] });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Close other EchoText tabs to enable recovery storage.'));
      });
      pending.catch(() => { pending = null; });
    }
    return pending;
  }
  async function run(stores, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const request = action(tx);
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save generation progress.'));
    });
  }
  App.GenerationStore = {
    list: () => run(['jobs'], 'readonly', (tx) => tx.objectStore('jobs').getAll()),
    get: (id) => run(['jobs'], 'readonly', (tx) => tx.objectStore('jobs').get(id)),
    create: (job) => run(['jobs'], 'readwrite', (tx) => tx.objectStore('jobs').put(job)),
    part: (id, index) => run(['parts'], 'readonly', (tx) => tx.objectStore('parts').get([id, index])),
    save(job, part) {
      return run(['jobs', 'parts'], 'readwrite', (tx) => {
        tx.objectStore('parts').put({ ...part, jobId: job.id });
        tx.objectStore('jobs').put(job);
      });
    },
    remove(id) {
      return run(['jobs', 'parts'], 'readwrite', (tx) => {
        tx.objectStore('jobs').delete(id);
        tx.objectStore('parts').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      });
    },
  };
})(window.VoiceAI = window.VoiceAI || {});
