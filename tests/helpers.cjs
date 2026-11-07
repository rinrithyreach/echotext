const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const root = path.resolve(__dirname, '..');

function createApp() {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="root"></main><div id="toast-region"></div><div id="modal-root"></div></body></html>', {
    url: pathToFileURL(path.join(root, 'index.html')).href,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.indexedDB = new IDBFactory();
      window.IDBKeyRange = IDBKeyRange;
      window.Blob = Blob;
      // Node's Blob returns Node-realm buffers; keep the WASM/ORT boundary in that realm too.
      for (const name of ['ArrayBuffer', 'DataView', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'WebAssembly']) window[name] = globalThis[name];
      window.fetch = (url, options) => {
        if (!String(url).startsWith('blob:')) throw new Error('Tests must not fetch remote resources: ' + url);
        return fetch(url, options);
      };
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      // .docx import inflates with DecompressionStream and reads the result through Response.
      window.DecompressionStream = DecompressionStream;
      window.CompressionStream = CompressionStream;
      window.Response = Response;
      window.ReadableStream = ReadableStream;
      window.structuredClone = structuredClone;
      window.URL.createObjectURL = URL.createObjectURL;
      window.URL.revokeObjectURL = URL.revokeObjectURL;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.scrollTo = () => {};
      const data = new Map();
      Object.defineProperty(window, 'localStorage', { value: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key) } });
      Object.defineProperty(window, 'sessionStorage', { value: window.localStorage });
      Object.defineProperty(window, 'isSecureContext', { value: true });
    },
  });
  const scripts = fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script defer src="([^"]+)"/g);
  for (const [, file] of scripts) {
    const source = new URL(file, pathToFileURL(path.join(root, 'index.html')));
    source.search = '';
    source.hash = '';
    const sourcePath = fileURLToPath(source);
    if (sourcePath === path.join(root, 'assets/js/app.js')) continue;
    dom.window.eval(fs.readFileSync(sourcePath, 'utf8'));
  }
  return { dom, window: dom.window, app: dom.window.VoiceAI, errors };
}
module.exports = { createApp, root };
