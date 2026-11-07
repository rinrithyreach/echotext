/**
 * EchoText — AI voices (run inside the browser)
 *
 * Every voice is generated entirely in this browser, with no server or account.
 * Two engines share one ONNX Runtime:
 *
 *   Piper (English):  text → phonemes (espeak-ng, piper_phonemize.wasm) → audio
 *   MMS   (Khmer):    text → Khmer letters (khmer-text.js) → audio
 *
 * Default voices (Kristin and the Khmer voice) and the engine come with
 * EchoText in assets/voices, so they work offline and are never downloaded.
 *
 * Both scripts are classic (not ES modules) and every binary is handed over
 * from memory, because Chrome blocks module scripts and fetch() for pages
 * opened straight from disk (file://).
 */
(function (App) {
  'use strict';

  const t = (text, params) => (App.t ? App.t(text, params) : text);

  const ORT_SRC = 'assets/vendor/ort.wasm.min.js'; // ONNX Runtime Web 1.18.0 (MIT)
  const PHONEMIZER_SRC = 'assets/vendor/piper_phonemize.js'; // piper-phonemize + espeak-ng build (diffusionstudio/piper-wasm)
  const ORT_FILE = { key: 'ort-wasm-simd.wasm', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm', size: 10595041 };
  const PHONEMIZER_FILES = [
    { key: 'piper_phonemize.wasm', url: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm', size: 635212 },
    { key: 'piper_phonemize.data', url: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data', size: 18077249 },
  ];
  const RUNTIME_FILES = [ORT_FILE, ...PHONEMIZER_FILES];
  const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

  // Files that come with EchoText: key → how many scripts in assets/voices hold it (base64, ~22 MB
  // each: scripts are the only local files a page opened from disk may read).
  const BUNDLE_DIR = 'assets/voices';
  const BUNDLED = {
    'ort-wasm-simd.wasm': 1,
    'piper_phonemize.wasm': 1,
    'piper_phonemize.data': 2,
    'en_US-kristin-medium.onnx': 4,
    'en_US-kristin-medium.onnx.json': 1,
    'km_KH-mms-medium.onnx': 7,
    'km_KH-mms-medium.onnx.json': 1,
  };

  /**
   * One built-in default voice for each speech language.
   */
  const VOICES = [
    { id: 'en_US-kristin-medium', name: 'Kristin', language: 'en-US', gender: 'female', engine: 'piper', path: 'en/en_US/kristin/medium', size: 63531379, configSize: 4968, bundled: true, license: 'Public domain' },
    // Meta MMS-TTS Khmer (facebook/mms-tts-khm), converted to ONNX by tools/convert-mms-khmer.py.
    { id: 'km_KH-mms-medium', name: 'Khmer (MMS)', language: 'km-KH', gender: 'male', engine: 'mms', size: 114237250, configSize: 945, bundled: true, license: 'CC BY-NC 4.0' },
  ];

  const RUNTIME = { id: 'runtime', name: 'Speech engine', size: RUNTIME_FILES.reduce((sum, f) => sum + f.size, 0), bundled: true };

  const MAX_IDS = 400; // longest phoneme sequence per Piper inference step (longer sentences split at a word break)
  const PEAK = 0.9; // each sentence is normalised to this level, like Piper itself
  const BOS = 1;
  const EOS = 2;
  const PAD = 0;
  const SPACE = 3;
  const DEFAULT_GAP = 0.2; // seconds between sentences when no pause is given
  const LOW_MEMORY_GB = 4; // navigator.deviceMemory below this: warn before loading a voice

  /* ---------- File cache (IndexedDB) ---------- */

  const DB_NAME = 'voiceai-ai-voices';
  const STORE = 'files';
  let dbPromise = null;

  function openDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('AI voice storage is blocked by another open tab.'));
      });
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  async function run(mode, operation) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
    });
  }

  const cache = {
    async get(key) {
      const record = await run('readonly', (store) => store.get(key));
      return record ? record.blob : null;
    },
    put(key, blob) {
      return run('readwrite', (store) => store.put({ key, blob, size: blob.size, savedAt: Date.now() }));
    },
    keys() {
      return run('readonly', (store) => store.getAllKeys());
    },
    /** key → size, without reading the files themselves. */
    async sizes() {
      const out = new Map();
      await run('readonly', (store) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          out.set(cursor.value.key, cursor.value.size || 0);
          cursor.continue();
        };
        return null;
      });
      return out;
    },
    delete(key) {
      return run('readwrite', (store) => store.delete(key));
    },
  };

  /* ---------- Activity (what's loading right now, for progress in the UI) ---------- */

  const activity = new Map(); // voice id | 'runtime' → { phase, loaded, total }
  function setActivity(id, info) {
    if (info) activity.set(id, info);
    else activity.delete(id);
    if (App.bus) App.bus.emit('models:change', { id, activity: info || null });
  }
  const tracking = (id, onProgress) => (info) => {
    setActivity(id, info);
    if (onProgress) onProgress(info);
  };

  /* ---------- Downloads ---------- */

  const aborted = () => new App.TTSError(t('Cancelled.'), { code: 'aborted' });

  // A file is kept in pieces while it downloads, so closing or reloading the page (or losing the
  // connection) halfway through carries on from the last piece next time instead of starting over.
  const PIECE = 8 * 1024 * 1024;
  const pieceKey = (file, n) => `${file.key}#${String(n).padStart(3, '0')}`;
  const isPiece = (key, file) => key.startsWith(`${file.key}#`);

  /** The pieces of `file` kept by an earlier, unfinished download, in order. */
  async function savedPieces(file) {
    const keys = (await cache.keys().catch(() => [])).filter((key) => isPiece(key, file)).sort();
    const pieces = [];
    for (const [n, key] of keys.entries()) {
      const blob = key === pieceKey(file, n) ? await cache.get(key).catch(() => null) : null;
      if (!blob) break; // a gap: only what comes before it is usable
      pieces.push(blob);
    }
    return pieces;
  }

  async function dropPieces(file) {
    const keys = (await cache.keys().catch(() => [])).filter((key) => isPiece(key, file));
    await Promise.all(keys.map((key) => cache.delete(key).catch(() => {})));
  }

  async function request(file, from) {
    try {
      return await fetch(file.url, from ? { headers: { Range: `bytes=${from}-` } } : undefined);
    } catch (err) {
      if (from) return null; // the server wouldn't take a resume request: fetch it whole
      throw new App.TTSError(t('Couldn’t download the AI voice. Check your internet connection and try again.'), { code: 'network', cause: err });
    }
  }

  async function fetchFile(file, onBytes) {
    if (!file.url) {
      throw new App.TTSError(t('A built-in voice file is missing from assets/voices. Copy EchoText again to restore it.'), { code: 'missing_bundle' });
    }
    const pieces = await savedPieces(file);
    let have = pieces.reduce((sum, blob) => sum + blob.size, 0);
    let response = await request(file, have);
    if (have && (!response || response.status !== 206)) {
      // No resume (or the pieces already add up to the whole file): fetch it whole. The pieces
      // are dropped only once that works, so being offline doesn't lose them.
      if (!response || response.status !== 200) {
        if (response && response.body) response.body.cancel().catch(() => {});
        response = await request(file, 0);
      }
      if (response.ok) {
        await dropPieces(file);
        pieces.length = 0;
        have = 0;
      }
    }
    if (!response.ok) {
      throw new App.TTSError(t('Couldn’t download the AI voice (HTTP {status}).', { status: response.status }), { code: 'network', status: response.status });
    }
    if (have) onBytes(have);
    const reader = response.body.getReader();
    let chunks = [];
    let buffered = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        buffered += value.length;
        onBytes(value.length);
        if (buffered >= PIECE) {
          const piece = new Blob(chunks);
          await cache.put(pieceKey(file, pieces.length), piece).catch(() => {});
          pieces.push(piece);
          chunks = [];
          buffered = 0;
        }
      }
    } catch (err) {
      throw new App.TTSError(t('The AI voice download was interrupted. It carries on from here next time.'), { code: 'network', cause: err });
    }
    const blob = new Blob([...pieces, ...chunks]);
    if (have && blob.size !== file.size) {
      // Resumed onto a file that changed on the server: the pieces don't fit, so fetch it whole.
      await dropPieces(file);
      return fetchFile(file, onBytes);
    }
    return blob;
  }

  // Files downloading right now: key → { loaded, promise, listeners }. Two clicks that need the same
  // file share one download instead of fetching it twice.
  const downloads = new Map();

  function download(file) {
    let entry = downloads.get(file.key);
    if (!entry) {
      entry = { loaded: 0, listeners: new Set() };
      entry.promise = fetchFile(file, (n) => {
        entry.loaded += n;
        entry.listeners.forEach((listener) => listener());
      })
        .then(async (blob) => {
          try {
            await cache.put(file.key, blob);
            // Use the stored copy from here on: `blob` may be built from the pieces dropped next.
            const kept = await cache.get(file.key);
            await dropPieces(file);
            return kept || blob;
          } catch (err) {
            console.warn('[EchoText] Couldn’t keep the AI voice for next time.', err);
            return blob;
          }
        })
        .finally(() => downloads.delete(file.key));
      entry.promise.catch(() => {}); // waiters get the error; nobody waiting isn't an error
      downloads.set(file.key, entry);
    }
    return entry;
  }

  /** Waits for `promise`, unless `signal` aborts first (the download itself carries on and is kept). */
  function unlessAborted(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const stop = () => reject(aborted());
      signal.addEventListener('abort', stop, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  /* ---------- Files that come with EchoText ---------- */

  const received = new Map(); // `${key}#${part}` → base64, handed over by the assets/voices scripts

  function fromBase64(text) {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** A file that comes with EchoText, read from its scripts. Null when they're missing. */
  async function readBundled(file) {
    const parts = [];
    for (let n = 0; n < BUNDLED[file.key]; n++) {
      const id = `${file.key}#${n}`;
      try {
        await runScript(`${BUNDLE_DIR}/${file.key}.${n}.js`);
      } catch {
        return null;
      }
      if (!received.has(id)) return null;
      parts.push(fromBase64(received.get(id)));
      received.delete(id);
    }
    return new Blob(parts);
  }

  /** Every file in `files`: bundled, cached or downloaded (and cached). Resolves to Map(key → Blob). */
  async function ensureFiles(files, onProgress, signal) {
    const out = new Map();
    const missing = [];
    for (const file of files) {
      const blob = (BUNDLED[file.key] ? await readBundled(file) : null) || (await cache.get(file.key).catch(() => null));
      if (blob) out.set(file.key, blob);
      else missing.push(file);
    }
    if (!missing.length) return out;

    const total = missing.reduce((sum, f) => sum + f.size, 0);
    const entries = missing.map((file) => [file, download(file)]);
    const report = () => {
      const loaded = entries.reduce((sum, [, entry]) => sum + entry.loaded, 0);
      if (onProgress) onProgress({ phase: 'download', loaded: Math.min(loaded, total), total });
    };
    entries.forEach(([, entry]) => entry.listeners.add(report));
    report();
    try {
      for (const [file, entry] of entries) out.set(file.key, await unlessAborted(entry.promise, signal));
    } finally {
      entries.forEach(([, entry]) => entry.listeners.delete(report));
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return out;
  }

  function voiceFiles(voice) {
    const url = (name) => (voice.engine === 'piper' ? `${VOICE_BASE}/${voice.path}/${name}` : null);
    return [
      { key: `${voice.id}.onnx`, url: url(`${voice.id}.onnx`), size: voice.size },
      { key: `${voice.id}.onnx.json`, url: url(`${voice.id}.onnx.json`), size: voice.configSize || 5000 },
    ];
  }

  /* ---------- Runtime ---------- */

  function runScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`${src} couldn’t be loaded.`));
      };
      document.head.appendChild(script);
    });
  }

  async function loadScript(src, ready) {
    if (ready()) return;
    await runScript(src);
    if (!ready()) throw new Error(`${src} didn’t start.`);
  }

  let ortPromise = null;
  let phonemizerPromise = null;

  /** Loads ONNX Runtime once per page. */
  function loadOrt(onProgress, signal) {
    if (!ortPromise) {
      ortPromise = (async () => {
        const files = await ensureFiles([ORT_FILE], onProgress, signal);
        await loadScript(ORT_SRC, () => !!window.ort);
        const ort = window.ort;
        ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which file:// doesn't have
        ort.env.wasm.proxy = false; // its worker can't read this page's blob: URLs on file://
        ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': URL.createObjectURL(new Blob([files.get(ORT_FILE.key)], { type: 'application/wasm' })) };
        return ort;
      })();
      ortPromise.catch(() => {
        ortPromise = null;
      });
    }
    return ortPromise;
  }

  /** Loads the espeak-ng phonemizer (English voices only) once per page. */
  function loadPhonemizer(onProgress, signal) {
    if (!phonemizerPromise) {
      phonemizerPromise = (async () => {
        const files = await ensureFiles(PHONEMIZER_FILES, onProgress, signal);
        await loadScript(PHONEMIZER_SRC, () => typeof window.createPiperPhonemize === 'function');
        const [wasm, data] = await Promise.all([files.get('piper_phonemize.wasm').arrayBuffer(), files.get('piper_phonemize.data').arrayBuffer()]);
        return { wasm, data };
      })();
      phonemizerPromise.catch(() => {
        phonemizerPromise = null;
      });
    }
    return phonemizerPromise;
  }

  async function loadRuntime(voice, onProgress, signal) {
    const ort = await loadOrt(onProgress, signal);
    const phonemizer = voice.engine === 'piper' ? await loadPhonemizer(onProgress, signal) : null;
    return { ort, phonemizer };
  }

  let loaded = null; // { id, session, config } — one voice in memory at a time

  function release() {
    if (!loaded) return false;
    const { session } = loaded;
    loaded = null;
    Promise.resolve(session.release && session.release()).catch(() => {});
    return true;
  }

  async function loadVoice(rt, voice, onProgress, signal) {
    if (loaded && loaded.id === voice.id) return loaded;
    const files = await ensureFiles(voiceFiles(voice), onProgress, signal);
    if (onProgress) onProgress({ phase: 'load' });
    const config = JSON.parse(await files.get(`${voice.id}.onnx.json`).text());
    const model = await files.get(`${voice.id}.onnx`).arrayBuffer();
    release();
    const session = await rt.ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    loaded = { id: voice.id, session, config };
    return loaded;
  }

  /* ---------- Piper (English) ---------- */

  /** One JSON result per cue, preserving the text-to-audio boundaries. */
  async function phonemize(rt, texts, espeakVoice) {
    const lines = [];
    const errors = [];
    const module = await window.createPiperPhonemize({
      wasmBinary: rt.phonemizer.wasm,
      getPreloadedPackage: () => rt.phonemizer.data,
      print: (line) => lines.push(line),
      printErr: (line) => errors.push(line),
    });
    module.callMain(['-l', espeakVoice, '--input', JSON.stringify(texts.map((text) => ({ text }))), '--espeak_data', '/espeak-ng-data']);
    const ids = lines.filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line).phoneme_ids);
    if (ids.length !== texts.length || ids.some((part) => !part || !part.length)) {
      throw new App.TTSError(t('The AI voice couldn’t read this text.'), { code: 'phonemize_failed', cause: errors.join('\n') });
    }
    return ids;
  }

  /** Splits phoneme ids into sentences, and over-long sentences at word breaks. */
  function splitIds(ids) {
    const sentences = [];
    let current = [];
    for (const id of ids) {
      current.push(id);
      if (id === EOS) {
        sentences.push(current);
        current = [];
      }
    }
    if (current.length > 2) sentences.push([...current, EOS]);

    const out = [];
    for (const sentence of sentences) {
      let rest = sentence;
      while (rest.length > MAX_IDS) {
        // Cut after the last word break (space + its pad) that keeps the piece short enough.
        let cut = -1;
        for (let i = MAX_IDS - 2; i > 2; i--) {
          if (rest[i] === SPACE && rest[i + 1] === PAD) {
            cut = i + 2;
            break;
          }
        }
        if (cut < 0) cut = MAX_IDS - 1 - ((MAX_IDS - 1) % 2); // no word break: cut between phonemes
        out.push([...rest.slice(0, cut), EOS]);
        rest = [BOS, PAD, ...rest.slice(cut)];
      }
      out.push(rest);
    }
    return out.filter((piece) => piece.some((id) => id > SPACE));
  }

  /* ---------- MMS (Khmer) ---------- */

  /**
   * Token ids the way the MMS tokenizer makes them: lower-cased, only characters in the vocabulary,
   * one blank (pad id) between and around every character.
   */
  function mmsTokens(config, text) {
    const vocab = config.vocab;
    const chars = Array.from(String(text).toLowerCase().replace(/\s+/g, ' ').trim()).filter((ch) => ch in vocab);
    while (chars.length && chars[chars.length - 1] === ' ') chars.pop();
    if (!chars.some((ch) => ch !== ' ')) return [];
    const ids = chars.map((ch) => vocab[ch]);
    if (!config.add_blank) return ids;
    const out = [config.pad_id];
    ids.forEach((id) => out.push(id, config.pad_id));
    return out;
  }

  /** Splits a long MMS input at a space so each inference step stays a sensible size. */
  function splitMms(config, text, max = 380) {
    const out = [];
    let rest = String(text).trim();
    while (rest) {
      const ids = mmsTokens(config, rest);
      if (ids.length <= max) {
        if (ids.length) out.push(ids);
        break;
      }
      const limit = Math.floor((max - 1) / 2); // characters that fit
      let cut = rest.lastIndexOf(' ', limit);
      if (cut < limit / 3) cut = limit;
      out.push(mmsTokens(config, rest.slice(0, cut)));
      rest = rest.slice(cut).trim();
    }
    return out.filter((ids) => ids.length);
  }

  /* ---------- Inference ---------- */

  async function infer(rt, model, voice, ids, rate) {
    const { ort } = rt;
    const config = model.config;
    let noise;
    let lengthScale;
    let noiseW;
    if (voice.engine === 'mms') {
      noise = config.noise_scale ?? 0.667;
      lengthScale = 1 / (config.speaking_rate || 1) / rate;
      noiseW = config.noise_scale_duration ?? 0.8;
    } else {
      const { inference = {} } = config;
      noise = inference.noise_scale ?? 0.667;
      lengthScale = (inference.length_scale || 1) / rate;
      noiseW = inference.noise_w ?? 0.8;
    }
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      scales: new ort.Tensor('float32', Float32Array.from([noise, lengthScale, noiseW]), [3]),
    };
    if (voice.engine === 'piper') {
      feeds.input_lengths = new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]);
      if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    }
    const result = await model.session.run(feeds);
    return result.output.data;
  }

  function normalise(samples, gain) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const scale = (PEAK / Math.max(peak, 0.01)) * gain;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * scale;
    return out;
  }

  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

  // One synthesis (or load / unload) at a time: they share the loaded voice and its inference session.
  let queue = Promise.resolve();
  function enqueue(task) {
    const job = queue.then(task);
    queue = job.catch(() => {});
    return job;
  }

  /* ---------- Device check ---------- */

  async function storageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        const persisted = navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
        return { usage, quota, available: Math.max(0, quota - usage), persisted, known: quota > 0 };
      }
    } catch {
      /* not available */
    }
    return { usage: 0, quota: 0, available: 0, persisted: false, known: false };
  }

  /* ---------- Public API ---------- */

  const AIVoice = {
    voices: VOICES,
    runtime: RUNTIME,

    /** True when this browser can run the AI voices at all. */
    isSupported() {
      return typeof WebAssembly === 'object' && 'indexedDB' in window && typeof BigInt64Array === 'function';
    },

    /** True when there is an AI voice for the language. */
    supports(language) {
      return this.isSupported() && VOICES.some((v) => v.language === language);
    },

    /** Voices for a language. */
    forLanguage(language) {
      return VOICES.filter((v) => v.language === language);
    },

    /** The default voice for a language + gender. */
    pick(language, gender) {
      const list = VOICES.filter((v) => v.language === language);
      return list.find((v) => v.gender === gender && v.bundled) || list.find((v) => v.gender === gender) || list.find((v) => v.bundled) || list[0] || null;
    },

    /** Called by the assets/voices scripts with their part of a file. */
    receive(key, part, base64) {
      received.set(`${key}#${part}`, base64);
    },

    /** The AI voice for `item` ({ voiceId, language, gender }). */
    voiceFor(item) {
      if (!item) return null;
      return VOICES.find((voice) => voice.id === item.voiceId && (!item.language || voice.language === item.language)) || this.pick(item.language, item.gender);
    },

    get(id) {
      return id === RUNTIME.id ? RUNTIME : VOICES.find((voice) => voice.id === id) || null;
    },

    /** What's loading right now: { phase, loaded, total } or null. */
    activity(id) {
      return activity.get(id) || null;
    },

    /**
     * Where a voice is and what it's doing:
     * { bundled, installed, partial, inMemory, downloadedBytes, activity }
     */
    async status(voice) {
      const sizes = await cache.sizes().catch(() => new Map());
      const files = voice.id === RUNTIME.id ? RUNTIME_FILES : voiceFiles(voice);
      const bundled = files.every((f) => BUNDLED[f.key]);
      const cached = files.every((f) => sizes.has(f.key));
      let downloadedBytes = 0;
      let partial = false;
      for (const [key, size] of sizes) {
        if (files.some((f) => key === f.key)) downloadedBytes += size;
        else if (files.some((f) => isPiece(key, f))) {
          downloadedBytes += size;
          partial = true;
        }
      }
      const inMemory = voice.id === RUNTIME.id ? !!ortPromise : !!(loaded && loaded.id === voice.id);
      return { bundled, installed: bundled || cached, partial: !cached && partial, inMemory, downloadedBytes, activity: activity.get(voice.id) || null };
    },

    /** Browser storage: { usage, quota, available, persisted, known }. */
    storage: storageEstimate,

    /** Asks the browser to keep downloaded voices and History even when space runs low. */
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return false;
      return navigator.storage.persist().catch(() => false);
    },

    /**
     * Checks this device before a voice is loaded: { ok, errors: [], warnings: [] }.
     * Errors stop the voice from loading; warnings are shown and may be accepted.
     */
    async checkDevice(voice) {
      const errors = [];
      const warnings = [];
      if (typeof WebAssembly !== 'object') errors.push(t('This browser can’t run WebAssembly, which the AI voices need. Use a recent Chrome, Edge, Firefox or Safari.'));
      if (typeof BigInt64Array !== 'function') errors.push(t('This browser is too old for the AI voices. Update it and try again.'));
      if (!voice) return { ok: !errors.length, errors, warnings };
      const status = await this.status(voice);
      if (!status.installed) {
        if (!('indexedDB' in window)) warnings.push(t('Browser storage is off, so {name} will be downloaded again every time.', { name: voice.name }));
        const storage = await storageEstimate();
        const needed = voice.size - status.downloadedBytes;
        if (storage.known && storage.available < needed * 1.1) {
          errors.push(t('{name} needs {size} of browser storage, but only {free} is free. Remove other voices or History items first.', {
            name: voice.name, size: App.utils.formatBytes(needed), free: App.utils.formatBytes(storage.available),
          }));
        }
        if (navigator.onLine === false) errors.push(t('{name} has to be downloaded first, and this device is offline.', { name: voice.name }));
      }
      const memory = navigator.deviceMemory;
      if (memory && memory < LOW_MEMORY_GB) {
        warnings.push(t('This device reports {memory} GB of memory. Loading {name} ({size}) may be slow or close other tabs.', {
          memory, name: voice.name, size: App.utils.formatBytes(voice.size),
        }));
      }
      return { ok: !errors.length, errors, warnings };
    },

    /** Downloads a voice's files (if they don't come with EchoText) without loading it. */
    install(voice, { onProgress, signal } = {}) {
      return enqueue(async () => {
        const check = await this.checkDevice(voice);
        if (!check.ok) throw new App.TTSError(check.errors[0], { code: 'incompatible' });
        const report = tracking(voice.id, onProgress);
        try {
          if ((await this.status(voice)).installed) return;
          await ensureFiles(voiceFiles(voice), report, signal);
        } finally {
          setActivity(voice.id, null);
        }
      });
    },

    /** Loads a voice into memory now, so the next generation starts at once. */
    load(voice, { onProgress, signal } = {}) {
      return enqueue(async () => {
        const check = await this.checkDevice(voice);
        if (!check.ok) throw new App.TTSError(check.errors[0], { code: 'incompatible' });
        const report = tracking(voice.id, onProgress);
        try {
          const rt = await loadRuntime(voice, report, signal);
          await loadVoice(rt, voice, report, signal);
        } finally {
          setActivity(voice.id, null);
        }
      });
    },

    /** Frees the memory a loaded voice uses. Its files stay. */
    unload(voice) {
      return enqueue(async () => {
        const was = loaded && loaded.id === voice.id && release();
        setActivity(voice.id, null);
        return !!was;
      });
    },

    /** Unloads a voice and deletes its downloaded files. Built-in voices only unload. */
    remove(voice) {
      return enqueue(async () => {
        if (loaded && loaded.id === voice.id) release();
        const files = voiceFiles(voice).filter((f) => !BUNDLED[f.key]);
        for (const file of files) {
          await cache.delete(file.key).catch(() => {});
          await dropPieces(file);
        }
        setActivity(voice.id, null);
        return files.length > 0;
      });
    },

    /**
     * Repairs a voice: unloads it, deletes its downloaded copy (downloading it again), reads the
     * built-in files again, loads it and speaks a short test. Resolves to { seconds }.
     */
    async repair(voice, { onProgress, signal } = {}) {
      if (voice.id === RUNTIME.id) {
        await enqueue(async () => {
          release();
          ortPromise = null;
          phonemizerPromise = null;
          for (const file of RUNTIME_FILES) {
            await cache.delete(file.key).catch(() => {});
            await dropPieces(file);
          }
        });
        const report = tracking(RUNTIME.id, onProgress);
        try {
          await enqueue(async () => {
            await loadOrt(report, signal);
            await loadPhonemizer(report, signal);
          });
        } finally {
          setActivity(RUNTIME.id, null);
        }
        return { seconds: 0 };
      }
      await this.remove(voice);
      const started = performance.now();
      const made = await this.synthesize({ text: App.config.getLanguage(voice.language).sample, voiceId: voice.id, language: voice.language, gender: voice.gender, rate: 1, pitch: 1 }, { onProgress, signal });
      if (!made.samples.length || !made.samples.some((s) => Math.abs(s) > 0.01)) throw new App.TTSError(t('The voice loaded but produced silence.'), { code: 'silent' });
      return { seconds: (performance.now() - started) / 1000 };
    },

    /**
     * Deletes downloaded files nothing uses any more: voices EchoText no longer has, and earlier
     * downloads of files that now come with EchoText.
     */
    async prune() {
      const known = new Set([...RUNTIME_FILES, ...VOICES.flatMap(voiceFiles)].map((f) => f.key));
      const unused = (key) => !known.has(key.split('#')[0]) || !!BUNDLED[key.split('#')[0]];
      const keys = await cache.keys().catch(() => []);
      await Promise.all(keys.filter(unused).map((key) => cache.delete(key).catch(() => {})));
    },

    /** Token ids for Khmer text (exposed for tests). */
    mmsTokens,

    /**
     * Speaks `item` ({ text | cueTexts, cueLabels?, gaps?, language, gender, voiceId, rate, pitch,
     * volume, sentencePause }) with its AI voice.
     *   cueTexts   what is spoken, one entry per speech segment
     *   cueLabels  the text for each measured segment (defaults to cueTexts)
     *   gaps       seconds of silence after each cue except the last
     * onProgress({ phase: 'download' | 'load' | 'speak', loaded, total })
     * Resolves to { samples: Float32Array, sampleRate, duration, voice, cues }.
     */
    synthesize(item, options = {}) {
      return enqueue(() => this._synthesize(item, options));
    },

    async _synthesize(item, { onProgress, signal } = {}) {
      if (signal && signal.aborted) throw aborted();
      const voice = this.voiceFor(item);
      if (!voice) throw new App.TTSError(t('There’s no AI voice for {language} yet.', { language: t(App.config.getLanguage(item.language).name) }), { code: 'no_voice' });
      if (!loaded || loaded.id !== voice.id) {
        const check = await this.checkDevice(voice);
        if (!check.ok) throw new App.TTSError(check.errors[0], { code: 'incompatible' });
      }

      // Neither engine has a pitch control: speak slower (or faster) by the pitch factor, then play
      // the samples back that much faster (or slower) — the length comes back and the pitch moves.
      const shift = 2 ** (App.utils.clamp(Number(item.pitch) || 1, 0.5, 1.5) - 1);
      const report = tracking(voice.id, onProgress);
      try {
        const rt = await loadRuntime(voice, report, signal);
        if (signal && signal.aborted) throw aborted();
        const model = await loadVoice(rt, voice, report, signal);
        if (signal && signal.aborted) throw aborted();

        const baseRate = voice.engine === 'mms' ? model.config.sample_rate : model.config.audio.sample_rate;
        const sampleRate = Math.round(baseRate * shift);
        const texts = item.cueTexts || App.TextSegments.cues(item.text, undefined, voice.language);
        const labels = item.cueLabels || texts;
        let groups;
        if (voice.engine === 'mms') {
          groups = texts.map((text) => splitMms(model.config, App.KhmerText.normalize(text)));
          if (!groups.some((pieces) => pieces.length)) {
            throw new App.TTSError(t('The Khmer voice reads Khmer script. Add Khmer text, or choose an English voice.'), { code: 'phonemize_failed' });
          }
        } else {
          const espeakVoice = (model.config.espeak && model.config.espeak.voice) || 'en-us';
          groups = (await phonemize(rt, texts, espeakVoice)).map(splitIds);
          if (groups.some((pieces) => !pieces.length)) throw new App.TTSError(t('The AI voice couldn’t read this text.'), { code: 'phonemize_failed' });
        }
        const total = groups.reduce((sum, pieces) => sum + pieces.length, 0);

        const rate = App.utils.clamp(Number(item.rate) || 1, 0.5, 2);
        const gain = App.utils.clamp(item.volume ?? 1, 0, 1);
        const sentencePause = Number.isFinite(Number(item.sentencePause)) ? Math.max(0, Number(item.sentencePause)) : DEFAULT_GAP;
        const silence = (seconds) => new Float32Array(Math.round(sampleRate * seconds));
        const parts = [];
        const cues = [];
        let frames = 0;
        let finished = 0;
        const push = (part) => {
          parts.push(part);
          frames += part.length;
        };
        for (let group = 0; group < groups.length; group++) {
          const start = frames / sampleRate;
          const pieces = groups[group];
          if (!pieces.length) push(silence(0.3)); // nothing this voice can read (a Latin word in Khmer text)
          for (let p = 0; p < pieces.length; p++) {
            report({ phase: 'speak', loaded: finished, total });
            await nextFrame();
            if (signal && signal.aborted) throw aborted();
            const part = normalise(await infer(rt, model, voice, pieces[p], rate / shift), gain);
            if (signal && signal.aborted) throw aborted();
            push(part);
            finished++;
            if (p < pieces.length - 1) push(silence(Math.min(sentencePause, DEFAULT_GAP))); // an over-long sentence split in two
          }
          cues.push({ text: labels[group], start, end: frames / sampleRate });
          if (group < groups.length - 1) {
            const gap = item.gaps && Number.isFinite(item.gaps[group]) ? item.gaps[group] : sentencePause;
            push(silence(Math.max(0, gap)));
          }
        }
        report({ phase: 'speak', loaded: total, total });

        const samples = new Float32Array(frames);
        let offset = 0;
        parts.forEach((part) => {
          samples.set(part, offset);
          offset += part.length;
        });
        return { samples, sampleRate, duration: samples.length / sampleRate, voice, cues };
      } finally {
        setActivity(voice.id, null);
      }
    },
  };

  App.AIVoice = AIVoice;
})(window.VoiceAI = window.VoiceAI || {});
